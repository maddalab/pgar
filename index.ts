import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as fs from 'fs';

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

const ssmRole = new aws.iam.Role("ssmRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal(
      aws.iam.Principals.SsmPrincipal,
    ),
  });

// create an IAM role for github runners (using ec2 service principal) 
const iamRole = new aws.iam.Role("ci-cd-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
})

// policies provided to the github runner
const managedPolicyArns: [string, string][] = [
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
for (const policy of managedPolicyArns) {
    // Create RolePolicyAttachment without returning it.
    const rpa = new aws.iam.RolePolicyAttachment(`ci-cd-${policy[0]}`,
        { policyArn: policy[1], role: iamRole.id }, { parent: iamRole }
    );
}

const instanceProfile = new aws.iam.InstanceProfile('ci-cd-instance', {
    role: iamRole.name
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
// let userDataRaw = fs.readFileSync('./files/userdata.sh')
// let userData = Buffer.from(userDataRaw).toString('base64')

export = async () => {
    const subnetIds = await vpc.privateSubnetIds;
    let counter = -1

    return subnetIds.map(subnet => {
        counter = counter + 1
        const instance = `ci-cd-server-${counter}`
        return new aws.ec2.Instance(instance, {
            iamInstanceProfile: instanceProfile,
            instanceType: "t2.large",
            vpcSecurityGroupIds: [ instanceSecurityGroups.id ], 
            ami: ami.id,
            subnetId: subnet,
            tags: {
                Name: instance
            }
        });
    })
}
