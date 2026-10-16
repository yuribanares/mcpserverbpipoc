// payloads.mjs — builds the exact JSON sent to AWS by the numbered scripts.
//
// Usage (called by the scripts, not by hand):
//   node scripts/lib/payloads.mjs <name>      → prints JSON to stdout
// All inputs come from environment variables already loaded by lib.sh.
// The files land in .state/payloads/ so you can open them and see precisely
// what was sent to AWS.
const env = process.env;
const need = (k) => {
  const v = env[k];
  if (v === undefined || v === '') { console.error(`Missing value: ${k}`); process.exit(2); }
  return v;
};
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Settings the MCP server reads (deploy/aws-agentcore/src/settings.js).
// Only these keys are copied from the profile file onto the runtime.
const SERVER_KEYS = [
  'BPI_API_URL', 'PARTNER_REGISTRY_SOURCE', 'PARTNER_REGISTRY_SECRET_ID', 'PARTNER_AUTH_MODE',
  'SESSION_STORE', 'SESSION_TABLE_NAME', 'ECHO_LOGS', 'BPI_MESSAGE_SIGNING',
];

const builders = {
  // ── Lightsail: run the mock bank container with a public HTTPS address ──
  'lightsail-deployment': () => ({
    serviceName: need('LIGHTSAIL_SERVICE'),
    containers: {
      mockbank: {
        image: need('MOCK_BANK_IMAGE'),
        environment: {
          PORT: '8080',
          DEMO_ECHO_LOGS: 'true',
          BPI_API_LATENCY_MS: String(env.MOCK_BANK_LATENCY_MS ?? '280'),
          PARTNER_NAME: env.PARTNER_NAME || 'DRAGONPAY CORP',
        },
        ports: { 8080: 'HTTP' },
      },
    },
    publicEndpoint: {
      containerName: 'mockbank',
      containerPort: 8080,
      healthCheck: { path: '/health', intervalSeconds: 10, timeoutSeconds: 5, healthyThreshold: 2, unhealthyThreshold: 3, successCodes: '200' },
    },
  }),

  // ── IAM: who may "wear" the runtime's role (only AgentCore, in this account) ──
  'iam-trust-policy': () => ({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'AllowAgentCoreToAssumeThisRole',
      Effect: 'Allow',
      Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
      Action: 'sts:AssumeRole',
      Condition: {
        StringEquals: { 'aws:SourceAccount': need('ACCOUNT_ID') },
        ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${need('AWS_REGION')}:${need('ACCOUNT_ID')}:*` },
      },
    }],
  }),

  // ── IAM: what the running MCP server is allowed to do ──
  'iam-permissions-policy': () => {
    const region = need('AWS_REGION'); const acct = need('ACCOUNT_ID');
    const st = [
      { Sid: 'WriteLogs', Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        Resource: [`arn:aws:logs:${region}:${acct}:log-group:/aws/bedrock-agentcore/runtimes/*`, `arn:aws:logs:${region}:${acct}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`] },
      { Sid: 'DescribeLogGroups', Effect: 'Allow', Action: ['logs:DescribeLogGroups'], Resource: [`arn:aws:logs:${region}:${acct}:log-group:*`] },
      { Sid: 'Tracing', Effect: 'Allow', Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'], Resource: ['*'] },
      { Sid: 'Metrics', Effect: 'Allow', Action: ['cloudwatch:PutMetricData'], Resource: ['*'], Condition: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } },
      { Sid: 'WorkloadIdentity', Effect: 'Allow', Action: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
        Resource: [`arn:aws:bedrock-agentcore:${region}:${acct}:workload-identity-directory/default`, `arn:aws:bedrock-agentcore:${region}:${acct}:workload-identity-directory/default/workload-identity/*`] },
    ];
    if (env.CODE_BUCKET) st.push({ Sid: 'ReadCodeZip', Effect: 'Allow', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${env.CODE_BUCKET}/*`] });
    if (env.DEPLOY_METHOD === 'container') {
      st.push({ Sid: 'PullImage', Effect: 'Allow', Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'], Resource: [`arn:aws:ecr:${region}:${acct}:repository/${need('ECR_REPO')}`] });
      st.push({ Sid: 'EcrLogin', Effect: 'Allow', Action: ['ecr:GetAuthorizationToken'], Resource: ['*'] });
    }
    if (env.PARTNER_REGISTRY_SOURCE === 'secretsmanager') {
      st.push({ Sid: 'ReadPartnerRegistry', Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'],
        Resource: [`arn:aws:secretsmanager:${region}:${acct}:secret:${need('PARTNER_REGISTRY_SECRET_ID')}*`] });
    }
    if (env.SESSION_STORE === 'dynamodb') {
      st.push({ Sid: 'SessionTable', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        Resource: [`arn:aws:dynamodb:${region}:${acct}:table/${need('SESSION_TABLE_NAME')}`] });
    }
    if (env.NETWORK_MODE === 'VPC') {
      st.push({ Sid: 'VpcNetworking', Effect: 'Allow', Action: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface', 'ec2:AssignPrivateIpAddresses', 'ec2:UnassignPrivateIpAddresses'], Resource: ['*'] });
    }
    return { Version: '2012-10-17', Statement: st };
  },

  // ── AgentCore Runtime: create (or update, when RUNTIME_ID is set) ──
  'agentcore-runtime': () => {
    const updating = !!env.RUNTIME_ID;
    const environmentVariables = { AWS_REGION: need('AWS_REGION') };
    for (const k of SERVER_KEYS) if (env[k] !== undefined && env[k] !== '') environmentVariables[k] = env[k];
    environmentVariables.BPI_API_URL = need('RESOLVED_BPI_API_URL');
    if (env.USER_POOL_ID) environmentVariables.COGNITO_USER_POOL_ID = env.USER_POOL_ID;
    if (env.PARTNER_JWT_CLIENT_MAP) environmentVariables.PARTNER_JWT_CLIENT_MAP = env.PARTNER_JWT_CLIENT_MAP;

    const agentRuntimeArtifact = env.DEPLOY_METHOD === 'container'
      ? { containerConfiguration: { containerUri: need('IMAGE_URI') } }
      : { codeConfiguration: {
          code: { s3: { bucket: need('CODE_BUCKET'), prefix: need('CODE_KEY') } },
          runtime: 'NODE_22',
          entryPoint: ['deploy/aws-agentcore/src/http-server.js'],
        } };

    const networkConfiguration = env.NETWORK_MODE === 'VPC'
      ? { networkMode: 'VPC', networkModeConfig: { subnets: list(need('VPC_SUBNET_IDS')), securityGroups: list(need('VPC_SECURITY_GROUP_IDS')) } }
      : { networkMode: 'PUBLIC' };

    const body = {
      ...(updating ? { agentRuntimeId: env.RUNTIME_ID } : { agentRuntimeName: need('RUNTIME_NAME') }),
      description: `BPI MCP Server (${need('PROFILE')} profile)`,
      agentRuntimeArtifact,
      roleArn: need('ROLE_ARN'),
      networkConfiguration,
      protocolConfiguration: { serverProtocol: 'MCP' },
      // The "front door": only tokens from our Cognito partner app clients get in.
      authorizerConfiguration: { customJWTAuthorizer: {
        discoveryUrl: need('COGNITO_DISCOVERY_URL'),
        allowedClients: list(need('COGNITO_CLIENT_IDS')),
      } },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: Number(env.IDLE_SESSION_TIMEOUT_SECONDS || 900),
        maxLifetime: Number(env.MAX_LIFETIME_SECONDS || 28800),
      },
      environmentVariables,
    };
    // In jwt mode the server re-checks the partner's token, so let it through.
    if (env.PARTNER_AUTH_MODE === 'jwt') body.requestHeaderConfiguration = { requestHeaderAllowlist: ['Authorization'] };
    return body;
  },
};

const name = process.argv[2];
if (!builders[name]) { console.error(`Unknown payload "${name}". Known: ${Object.keys(builders).join(', ')}`); process.exit(2); }
process.stdout.write(JSON.stringify(builders[name](), null, 2) + '\n');
