'use strict';

const fs = require('fs');
const path = require('path');
const S3TestServer = require('./index');

const HELP = `Usage: s3-test-server [options]

A lightweight Amazon S3 emulator for development and testing.

Options:
  -a, --address <host>             Hostname or IP to bind to (default: localhost)
  -p, --port <n>                   Port of the server (default: 4568)
  -d, --directory <path>           Data directory (default: a temporary directory)
      --access-key-id <id>         Access key clients must sign with (default: S3TEST)
      --secret-access-key <key>    Matching secret access key (default: S3TEST)
      --region <region>            Region reported by the server (default: us-east-1)
      --key <path>                 Path to a private key file for HTTPS
      --cert <path>                Path to a certificate file for HTTPS
      --service-endpoint <host>    Root domain for virtual-host-style access
                                   (default: amazonaws.com)
      --no-vhost-buckets           Disable virtual-host-style bucket addressing
      --allow-mismatched-signatures  Accept well-formed but incorrect signatures
      --reset-on-start             Clear the data directory when the server starts
      --reset-on-close             Delete all bucket data when the server closes
      --configure-bucket <name[,config,...]>
                                   Create a bucket at startup; optional paths to
                                   CORS/website/tagging XML files (repeatable)
  -s, --silent                     Suppress log output
  -v, --version                    Print the version and exit
  -h, --help                       Show this help

Example:
  s3-test-server -d ./s3-data -p 9000 \\
    --configure-bucket "website,./cors.xml,./website.xml"
`;

function parseArgs(argv) {
  const options = { configureBuckets: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      return argv[i];
    };
    switch (arg) {
      case '-a':
      case '--address':
        options.address = next();
        break;
      case '-p':
      case '--port':
        options.port = parseInt(next(), 10);
        break;
      case '-d':
      case '--directory':
        options.directory = path.resolve(next());
        break;
      case '--access-key-id':
        options.accessKeyId = next();
        break;
      case '--secret-access-key':
        options.secretAccessKey = next();
        break;
      case '--region':
        options.region = next();
        break;
      case '--key':
        options.key = fs.readFileSync(next());
        break;
      case '--cert':
        options.cert = fs.readFileSync(next());
        break;
      case '--service-endpoint':
        options.serviceEndpoint = next();
        break;
      case '--no-vhost-buckets':
        options.vhostBuckets = false;
        break;
      case '--allow-mismatched-signatures':
        options.allowMismatchedSignatures = true;
        break;
      case '--reset-on-start':
        options.resetOnStart = true;
        break;
      case '--reset-on-close':
        options.resetOnClose = true;
        break;
      case '--configure-bucket': {
        const [name, ...configPaths] = next().split(',');
        options.configureBuckets.push({
          name: name.trim(),
          configs: configPaths.map((configPath) =>
            fs.readFileSync(path.resolve(configPath.trim()))
          ),
        });
        break;
      }
      case '-s':
      case '--silent':
        options.silent = true;
        break;
      case '-v':
      case '--version':
        console.log(require('../package.json').version);
        process.exit(0);
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}\n`);
        console.error(HELP);
        process.exit(1);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = new S3TestServer(options);
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    await server.run();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { main };
