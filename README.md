# Pulumi Github Action Runner
Pulumi IaC for running Github Runners on AWS.

## To set up Github Action runners 

```
pulumi up
```

## To destroy Github action runners

```
pulumi destroy
```

## EC2 implementation

* Creates a VPC in 2 AZs
* Each AZ has a private and public subnet
* Each private subnet is configured with an instance of Github Runner
* Each public subnet is configured with a host for use with SSH
* NAT gateway is created in private subnet to route traffic from `Github Runner`
* Internet gateway is created in public subnet to route traffic to the internet


# Configurations

Configure pulumi with values for `aws:region`, `GITHUB_ACCESS_TOKEN`, `GITHUB_ACTIONS_RUNNER_CONTEXT` `keyName`.

`GITHUB_ACCESS_TOKEN` is PAT token save it to config as a secret

```
pulumi config set --secret GITHUB_ACCESS_TOKEN XXXX
```

`GITHUB_ACTIONS_RUNNER_CONTEXT` can be specified in two formats. One for user/repository for instance `https://github.com/maddalab/pulumi-poetry-actions/` or alternatively for organizations for instance `https://api.github.com/orgs/foobarorg/dashboard`

```
pulumi config set GITHUB_ACTIONS_RUNNER_CONTEXT https://github.com/maddalab/pulumi-poetry-actions/
```

# How to use

The intent of this repository is to both develop a pulumi solution for `Github Runner` and to dog food it for development as CI/CD. However by default the runners are shut down and not in use. To utilize the runners, follow the steps as below

```
# if you have multiple AWS profiles in your `credentials` file.
export AWS_PROFILE=<>
pulumi login
pulumi up
```
