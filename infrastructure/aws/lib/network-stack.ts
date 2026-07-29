import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { ParentixConfig } from './config';

interface NetworkStackProps extends StackProps {
  config: ParentixConfig;
}

/**
 * The VPC everything else lives in.
 *
 *   public            ALB only
 *   private (egress)  Fargate tasks — reach the internet through NAT
 *   isolated          RDS and ElastiCache — no route to or from the internet
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: config.network.maxAzs,
      natGateways: config.network.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Gateway endpoints cost nothing and keep S3 traffic (avatar uploads, ECR
    // image layers) off the NAT gateway, which is billed per GB.
    this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
