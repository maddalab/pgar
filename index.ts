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
});


// create an IAM role for github runners (using ec2 service principal) 
const cicdRole = createRole("ci-cd", "ec2.amazonaws.com", [
    ['AdministratorAccess', 'arn:aws:iam::aws:policy/AdministratorAccess']
]);

const runnerProfile = new aws.iam.InstanceProfile('ci-cd-runner', {
    role: cicdRole.name
});

// create an IAM role for bastion hosts (using ec2 service principal) 
const bastionRole = createRole("ci-cd-bastion", "ec2.amazonaws.com", [
    ['ReadOnlyAccess', 'arn:aws:iam::aws:policy/ReadOnlyAccess']
]);

const bastionHostProfile = new aws.iam.InstanceProfile('ci-cd-bastion-host', {
    role: bastionRole.name
});

// create an IAM role for receiving life cycle events from the asg
const lifecycleRole = createRole("ci-cd-lifecycle", "autoscaling.amazonaws.com", [
    ['AutoScalingNotificationAccessRole', 'arn:aws:iam::aws:policy/service-role/AutoScalingNotificationAccessRole'],
]);

// create an iam role for lambda executoon
const lambdaRole = createRole("ci-cd-scale-in", "lambda.amazonaws.com", [
    ['AWSLambdaBasicExecutionRole', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
    ['AmazonSSMFullAccess', 'arn:aws:iam::aws:policy/AmazonSSMFullAccess'],
    ['AutoScalingFullAccess', 'arn:aws:iam::aws:policy/AutoScalingFullAccess'],
]);

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
}));

// Define a security group for the ec2 instances.
// We allow egress all, and we also allow access to all ports from within the VPC subnet
// We notably don't allow SSH access, because we use AWS SSM for that instead.
// Check out SSM Run Commands and console as an alternative to accomplishing tasks
const instanceSecurityGroups = new aws.ec2.SecurityGroup('ci-cd-instance-securitygroup', {
    vpcId: vpc.id,
    description: "Allow all ports from same subnet",
    ingress: [{
        protocol: '-1',
        fromPort: 0,
        toPort: 0,
        cidrBlocks: [ "10.0.0.0/26"]
    }],
    egress: [{
        protocol: '-1',
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ['0.0.0.0/0'],
    }]
});

// This defines the userdata for the instances on startup.
// We read the file async, and then convert to a Base64 string
// mustache templating used to pass in information available in pulumi
const config = new pulumi.Config();
const userDataTemplate = fs.readFileSync(path.join(__dirname, "user_data.sh")).toString();
let userData = mustache.render(userDataTemplate, {
    GITHUB_ACCESS_TOKEN: config.require("GITHUB_ACCESS_TOKEN"),
    GITHUB_ACTIONS_RUNNER_CONTEXT: config.require("GITHUB_ACTIONS_RUNNER_CONTEXT")
});

// A key pair is manually set up and referenced here via keyname. key pair
// is used for ec2 instance. It is not necessary to set one up using the 
// console. Provide public key material via ssh-key property to create a new
// key association in aws
let keyName: pulumi.Input<string> | undefined = config.get("keyName");
if (!keyName) {
    const key = new aws.ec2.KeyPair("ci-cd", { keyName: "ci-cd", publicKey: config.require("ssh-key")})
    keyName = key.keyName;
}

const launchTemplate = new aws.ec2.LaunchTemplate("ci-cd-runner-template", {
    description: "Github Actions Runner template",
    imageId: ami.id,
    instanceType: "t2.large", // TODO: convert to config
    keyName: keyName,
    iamInstanceProfile: {
        arn: runnerProfile.arn
    },
    vpcSecurityGroupIds: [ instanceSecurityGroups.id ],
    userData: Buffer.from(userData).toString('base64')
});

// create a sns topic to receive ASG lifecycle events
const asgEventsTopic = new aws.sns.Topic("asg-events-topic");

// create an ASG for ec2 instances running github runners, terminating events
// are posted to a SNS with topic asg-events-topic. ASG is manually configured
// for now TODO: Determine CW even criteria to scale.
const runnerAsg = new aws.autoscaling.Group("ci-cd-runner-asg", {
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

// lambda function than listens to ASG events and ensures EC2 instance
// cleanly unregister themselves in github before terminating
const cb = new aws.lambda.CallbackFunction("ci-cd-scale-in-callback", {
    role: lambdaRole,
    callback: async (ev: any) => {
        console.log(JSON.stringify(ev));

        const aws = require("aws-sdk")
        const ssm = new aws.SSM();
        const autoscaling = new aws.AutoScaling();
        var msg = JSON.parse(ev.Records[0].Sns.Message);
        const lifecycleActionToken = msg.LifecycleActionToken;
        const asgName = msg.AutoScalingGroupName;
        const lifecycleHookName = msg.LifecycleHookName;
        const ec2InstanceId = msg.EC2InstanceId;
    
        const params = {
            'DocumentName': "AWS-RunShellScript",
            'InstanceIds': [ec2InstanceId],
            'Parameters': {
                'commands': ["./instance_terminating.sh"],
                'workingDirectory': ["/home/runner"]
            },
            'TimeoutSeconds': 600
        }

        console.log("Running shell script with " + JSON.stringify(params));
        const scr = ssm.sendCommand(params, function(err: any, data: any) {
            if (err) console.log(err, err.stack);
            else console.log("Proceeding to completeLifecycleAction " + JSON.stringify(data));
        }).promise();

        return scr.then(function (result: any) {
            console.log("Completing life cycle " + JSON.stringify(result));
            return autoscaling.completeLifecycleAction({
                'AutoScalingGroupName': asgName,
                'LifecycleActionResult': "CONTINUE",
                'LifecycleActionToken': lifecycleActionToken,
                'LifecycleHookName': lifecycleHookName
            }).promise();
        });
    }
});

asgEventsTopic.onEvent("ci-cd-scale-in", cb);

function createRole(rolePrefix: string, servicePrincipal: string, policies: [string, string][]) {

    const role = new aws.iam.Role(`${rolePrefix}-role`, {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
            Service: servicePrincipal,
        }),
    });

    /*
      Loop through the managed policies and attach
      them to the defined IAM role
    */
    for (const policy of policies) {
        // Create RolePolicyAttachment without returning it.
        const rpa = new aws.iam.RolePolicyAttachment(`${rolePrefix}-${policy[0]}`,
            { policyArn: policy[1], role: role.id }, { parent: role }
        );
    }
    return role;
}

