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

const jumpRole = new aws.iam.Role("ci-cd-jump-role", {
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
    ['CloudWatchFullAccess', 'arn:aws:iam::aws:policy/CloudWatchFullAccess']
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

const jumpHostPolicies: [string, string][] = [
    ['AmazonEC2FullAccess', 'arn:aws:iam::aws:policy/AmazonEC2FullAccess'],
    ['AmazonS3FullAccess', 'arn:aws:iam::aws:policy/AmazonS3FullAccess']
]

for (const policy of jumpHostPolicies) {
    // Create RolePolicyAttachment without returning it.
    const rpa = new aws.iam.RolePolicyAttachment(`ci-cd-jump-${policy[0]}`,
        { policyArn: policy[1], role: jumpRole.id }, { parent: jumpRole }
    );
}

const jumpHostProfile = new aws.iam.InstanceProfile('ci-cd-jump-host', {
    role: jumpRole.name
})

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
//Buffer.from(fs.readFileSync("user_data.sh")).toString('base64')

const key = new aws.ec2.KeyPair("github-runners", { keyName: "github-runners", publicKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDbavshc5QISWn8w55vuh/jaNOZObAIzJcvkJdDR4EWMpsuasGRMlW1Mpju3cE7l2P4ZitaoEe8rMLWtHbWVV7c75XeodbIMCvEa9e7Hv7zRh7raY4XHrpiebDmPdHW7HgmhR4wAo5O2OIHBYl82BzaYUJoOelKyZJeN2VNJrmsY+R1vN6+sVwmgZri0FEck1BZw5f0RCm5qNrMLwwjE61xmBiAfLADjzHmKlnbgJe3X13Pt/kE6YHCmshOUCAnyyBksjIn8ChEhhv/qSEqBfHHBoAuqDwJ7aYigpdDTLsuxT2GKc6VbBBECzBBjqytZqViggZCPbe5AiFiWYd7QCuqAMYfL99sr+6fMIAdq8hLulK++rxOa1oc//bBG1rrzbeVqO6MiQwUa3KO2uR9vpUaNZc4ySkixo/kwhk3iKt1UPyaATBCez47PIIcBFcj2ny/BDYgyt/9Sdnf4vJ3H+fgza14WghSEgeqSqiLTN/VarA5Ky0AhKQ9XbRwVoU/ks38cIEmW08t6wvzu1ahFDtD+7gnuNdxroG/xtxQu05mgN8QGigfUM/JnoNQm9OHQToEraq9l74Y0axGjwJFU7x30cDHUGbEanzTl7oDd8Bp4zYVhkWnhWPHQHxvh6wfwh0ppR6CbjJGADItovFkvvTZ4LLoQO55C437iE4+I41MGw== maddalab@gmail.com"})

// create ec2 instances for github runners
async function create_runners() {
    const subnetIds = await vpc.privateSubnetIds;
    let counter = -1

    return subnetIds.map(subnet => {
        counter = counter + 1
        const instance = `ci-cd-server-${counter}`
        return new aws.ec2.Instance(instance, {
            iamInstanceProfile: runnerProfile,
            instanceType: "t2.large",
            vpcSecurityGroupIds: [ instanceSecurityGroups.id ], 
            ami: ami.id,
            subnetId: subnet,
            tags: {
                Name: instance
            },
            keyName: key.keyName,
            userData: userData
        });
    })
}

aws.ec2.KeyPair

// create jump josts in public subnets that will let us ssh into github runners
async function create_hosts() {
    const subnetIds = await vpc.publicSubnetIds;
    let counter = -1

    return subnetIds.map(subnet => {
        counter = counter + 1
        const instance = `ci-cd-ssh-hosts-${counter}`
        return new aws.ec2.Instance(instance, {
            iamInstanceProfile: jumpHostProfile,
            instanceType: "t2.large",
            vpcSecurityGroupIds: [ instanceSecurityGroups.id ], 
            ami: ami.id,
            subnetId: subnet,
            tags: {
                Name: instance
            },
            keyName: key.keyName
        });
    })
}

export const runners = create_runners()
export const hosts = create_hosts()