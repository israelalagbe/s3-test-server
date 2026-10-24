'use strict';

const S3TestServer = require('../lib');

async function startServer(options = {}) {
  const server = new S3TestServer({
    port: 0,
    silent: true,
    resetOnClose: true,
    ...options,
  });
  const address = await server.run();
  return {
    server,
    endpoint: address.endpoint,
    port: address.port,
    close: () => server.close(),
  };
}

const CREDENTIALS = {
  accessKeyId: 'S3TEST',
  secretAccessKey: 'S3TEST',
};

module.exports = { startServer, CREDENTIALS };
