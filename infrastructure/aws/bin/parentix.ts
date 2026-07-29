#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { getConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { StorageStack } from '../lib/storage-stack';
import { ApiStack } from '../lib/api-stack';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

// `cdk deploy -c env=dev` — defaults to prod (see cdk.json).
const envName = (app.node.tryGetContext('env') as string) || 'prod';
const config = getConfig(envName);

const env: cdk.Environment = {
  account: config.account || process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

const prefix = `Parentix-${config.envName}`;

const network = new NetworkStack(app, `${prefix}-Network`, { env, config });

const data = new DataStack(app, `${prefix}-Data`, { env, config, vpc: network.vpc });

const storage = new StorageStack(app, `${prefix}-Storage`, { env, config });

const api = new ApiStack(app, `${prefix}-Api`, {
  env,
  config,
  vpc: network.vpc,
  database: data.database,
  databaseSecret: data.databaseSecret,
  appSecret: data.appSecret,
  uploadsBucket: storage.uploadsBucket,
  redisEndpoint: data.redisEndpoint,
});

const web = new WebStack(app, `${prefix}-Web`, {
  env,
  config,
  familyAppBucketName: storage.familyAppBucket.bucketName,
  adminAppBucketName: storage.adminAppBucket.bucketName,
  uploadsBucketName: storage.uploadsBucket.bucketName,
  loadBalancer: api.loadBalancer,
});

// Cross-stack references already imply most of this; stated explicitly so a
// partial `cdk deploy` cannot pick an order that fails.
data.addDependency(network);
api.addDependency(data);
api.addDependency(storage);
web.addDependency(api);
web.addDependency(storage);

cdk.Tags.of(app).add('Project', 'Parentix');
cdk.Tags.of(app).add('Environment', config.envName);
cdk.Tags.of(app).add('ManagedBy', 'CDK');
