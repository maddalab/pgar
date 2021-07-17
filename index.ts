import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as fs from 'fs';
import * as mustache from "mustache";
import * as path from "path";

// Define a new VPC
const vpc = new awsx.ec2.Vpc("ci-cd", {
    numberOfAvailabilityZones: 2,
    numberOfNatGateways: 2,
    cidrBlock: "10.0.0.0/26",
    subnets: [
        {type: "private", tags: {Name: "ci-cd-private"}},
        {type: "public", tags: {Name: "ci-cd-public"}}
    ],
    tags: {
        Name: "ci-cd"
    }
});

// create an IAM role for github runners (using ec2 service principal) 
const cicdRole = new aws.iam.Role("ci-cd-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
})

const bastionRole = new aws.iam.Role("ci-cd-bastion-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
})

// policies provided to the github runner
const runnerPolicies: [string, string][] = [
    ['AmazonEC2FullAccess', 'arn:aws:iam::aws:policy/AmazonEC2FullAccess'],
    ['AmazonSSMManagedInstanceCore', 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
    ['AmazonEC2ContainerRegistryPowerUser', 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser'],
    ['AutoScalingFullAccess', 'arn:aws:iam::aws:policy/AutoScalingFullAccess'],
    ['AmazonS3FullAccess', 'arn:aws:iam::aws:policy/AmazonS3FullAccess'],
    ['AmazonECSTaskExecutionRolePolicy', 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
    ['CloudWatchFullAccess', 'arn:aws:iam::aws:policy/CloudWatchFullAccess'],
    ['AmazonSNSFullAccess', 'arn:aws:iam::aws:policy/AmazonSNSFullAccess']
]

/*
  Loop through the managed policies and attach
  them to the defined IAM role
*/
for (const policy of runnerPolicies) {
    // Create RolePolicyAttachment without returning it.
    const rpa = new aws.iam.RolePolicyAttachment(`ci-cd-${policy[0]}`,
        { policyArn: policy[1], role: cicdRole.id }, { parent: cicdRole }
    );
}

const runnerProfile = new aws.iam.InstanceProfile('ci-cd-runner', {
    role: cicdRole.name
})

const bastionHostPolicies: [string, string][] = [
    ['AmazonEC2FullAccess', 'arn:aws:iam::aws:policy/AmazonEC2FullAccess'],
    ['AmazonS3FullAccess', 'arn:aws:iam::aws:policy/AmazonS3FullAccess'],
]

for (const policy of bastionHostPolicies) {
    // Create RolePolicyAttachment without returning it.
    const rpa = new aws.iam.RolePolicyAttachment(`ci-cd-bastion-${policy[0]}`,
        { policyArn: policy[1], role: bastionRole.id }, { parent: bastionRole }
    );
}

const bastionHostProfile = new aws.iam.InstanceProfile('ci-cd-bastion-host', {
    role: bastionRole.name
})

const lifecycleRole = new aws.iam.Role("ci-cd-lifecycle-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "autoscaling.amazonaws.com",
    }),
})

const lifecyclePolicies: [string, string][] = [
    ['AutoScalingNotificationAccessRole', 'arn:aws:iam::aws:policy/service-role/AutoScalingNotificationAccessRole'],
]

for (const policy of lifecyclePolicies) {
    // Create RolePolicyAttachment without returning it.
    const rpa = new aws.iam.RolePolicyAttachment(`ci-cd-lifecycle-${policy[0]}`,
        { policyArn: policy[1], role: lifecycleRole.id }, { parent: lifecycleRole }
    );
}

/*
  This grabs the AMI asynchronously so we can use it to pass to the launchtemplate etc
*/
const ami = pulumi.output(aws.ec2.getAmi({
    filters: [
        { name: "name", values: [ "ubuntu/images/hvm-ssd/ubuntu*" ] },
        { name: "architecture", values: ["x86_64"]}
    ],
    owners: ["099720109477"],
    mostRecent: true
}))

/*
  Define a security group for the ec2 instances.
  We allow egress all, and we also allow access to all ports from within the VPC subnet
  We notably don't allow SSH access, because we use AWS SSM for that instead
*/
const instanceSecurityGroups = new aws.ec2.SecurityGroup('ci-cd-instance-securitygroup', {
    vpcId: vpc.id,
    description: "Allow all ports from same subnet",
    ingress: [{
        protocol: '-1',
        fromPort: 0,
        toPort: 0,
        cidrBlocks: [ "10.0.0.0/26"]
    },{
        protocol: "tcp",
        fromPort: 22,
        toPort: 22,
        cidrBlocks: ["0.0.0.0/0"]
    },{
        protocol: "tcp",
        fromPort: 80,
        toPort: 80,
        cidrBlocks: ["0.0.0.0/0"]
    }, { 
        protocol: "tcp", 
        fromPort: 443, 
        toPort: 443, 
        cidrBlocks: ["0.0.0.0/0"]
    }],
    egress: [{
        protocol: '-1',
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ['0.0.0.0/0'],
    }]
})

/*
  This defines the userdata for the instances on startup.
  We read the file async, and then convert to a Base64 string because it's clean in the metadata
*/
const config = new pulumi.Config();
const userDataTemplate = fs.readFileSync(path.join(__dirname, "user_data.sh")).toString();
let userData = mustache.render(userDataTemplate, {
    GITHUB_ACCESS_TOKEN: config.require("GITHUB_ACCESS_TOKEN"),
    GITHUB_ACTIONS_RUNNER_CONTEXT: config.require("GITHUB_ACTIONS_RUNNER_CONTEXT")
})

let keyName: pulumi.Input<string> | undefined = config.get("keyName");
if (!keyName) {
    const key = new aws.ec2.KeyPair("ci-cd", { keyName: "ci-cd", publicKey: config.require("ssh-key")})
    keyName = key.keyName;
}

const launchTemplate = new aws.ec2.LaunchTemplate("ci-cd-runner-template", {
    description: "Github Actions Runner template",
    imageId: ami.id,
    instanceType: "t2.large",
    keyName: keyName,
    name: "ci-cd-runner-template",
    tags: {
        Name: "ci-cd-runner-template",
    },
    iamInstanceProfile: {
        arn: runnerProfile.arn
    },
    vpcSecurityGroupIds: [ instanceSecurityGroups.id ],
    userData: Buffer.from(userData).toString('base64')
});

// create a sns topic to receive ASG lifecycle events
const asgEventsTopic = new aws.sns.Topic("asg-events-topic")

// create an ASG for ec2 instances running github runners, terminating events
// are posted to a SNS Q with topic asg-events-topic
const runnerAsg = new aws.autoscaling.Group("ci-cd-runner-asg", {
    name: "ci-cd-runner-asg",
    desiredCapacity: 2,
    maxSize: 2,
    minSize: 1,
    healthCheckGracePeriod: 300,
    healthCheckType: "EC2",
    launchTemplate: {
        id: launchTemplate.id,
        version: `$Latest`,
    },
    vpcZoneIdentifiers: vpc.privateSubnetIds,
    initialLifecycleHooks: [{
        name: "asg-events-hook",
        defaultResult: "CONTINUE",
        lifecycleTransition: "autoscaling:EC2_INSTANCE_TERMINATING",
        notificationTargetArn: asgEventsTopic.arn,
        roleArn: lifecycleRole.arn
    }]
});

const tvs = asgEventsTopic.onEvent("ci-cd-scale-in", async ev =>{
    console.log("Processing " + JSON.stringify(ev));
})


// create a bastion hosts in the public subnet
export const bastionHost = vpc.publicSubnetIds.then(psnids => {
    const firstSubnetId = psnids[0]
    return new aws.ec2.Instance("ci-cd-ssh-host", {
        iamInstanceProfile: bastionHostProfile,
        instanceType: "t2.large",
        vpcSecurityGroupIds: [ instanceSecurityGroups.id ], 
        ami: ami.id,
        subnetId: firstSubnetId,
        tags: {
            Name: "ci-cd-ssh-host"
        },
        keyName: keyName
    })
})
