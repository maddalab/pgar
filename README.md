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
