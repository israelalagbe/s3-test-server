/// <reference types="node" />

import { EventEmitter } from 'events';
import { IncomingMessage, ServerResponse, Server as HttpServer } from 'http';

declare class S3TestServer extends EventEmitter {
  constructor(options?: S3TestServer.S3TestServerOptions);

  options: S3TestServer.ResolvedOptions;

  /** The underlying HTTP(S) server, available after `run()` resolves. */
  httpServer: HttpServer | null;

  /** Starts the server. */
  run(): Promise<S3TestServer.RunAddress>;
  run(
    callback: (err: Error | null, address?: S3TestServer.RunAddress) => void
  ): this;

  /** Stops the server (removing data when `resetOnClose` is set). */
  close(): Promise<void>;
  close(callback: (err: Error | null) => void): this;

  /** Returns a request handler for use with `http.createServer()` or Express. */
  callback(): S3TestServer.RequestHandler;
  /** Alias of {@link callback}. */
  getMiddleware(): S3TestServer.RequestHandler;

  /** Provisions the buckets in `options.configureBuckets` without the S3 API. */
  configureBuckets(): Promise<void>;

  /** Deletes all buckets, objects and configurations in the store. */
  reset(): Promise<void>;

  on(
    event: 'event',
    listener: (notification: S3TestServer.S3EventNotification) => void
  ): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(
    event: 'event',
    listener: (notification: S3TestServer.S3EventNotification) => void
  ): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
}

declare namespace S3TestServer {
  interface BucketConfiguration {
    /** Bucket name (must be a valid S3 bucket name). */
    name: string;
    /**
     * Raw XML configuration documents applied to the bucket at startup.
     * CORS (`<CORSConfiguration>`), website (`<WebsiteConfiguration>`) and
     * tagging (`<Tagging>`) documents are recognized by their root element.
     */
    configs?: Array<string | Buffer>;
  }

  interface S3TestServerOptions {
    /** Hostname or IP to bind to. Default: `"localhost"`. */
    address?: string;
    /** Port to listen on. Use `0` for an ephemeral port. Default: `4568`. */
    port?: number;
    /** Private key for HTTPS. When both `key` and `cert` are set, the server uses TLS. */
    key?: string | Buffer;
    /** Certificate for HTTPS. */
    cert?: string | Buffer;
    /** Suppress log output. Default: `false`. */
    silent?: boolean;
    /**
     * Directory in which buckets and objects are stored.
     * Default: a freshly created temporary directory.
     */
    directory?: string;
    /** Remove all bucket data when the server closes. Default: `false`. */
    resetOnClose?: boolean;
    /**
     * Accept well-formed signatures even when they do not match
     * (useful with exotic clients). Default: `false`.
     */
    allowMismatchedSignatures?: boolean;
    /** Enable virtual-host-style bucket addressing. Default: `true`. */
    vhostBuckets?: boolean;
    /**
     * Root domain used to recognize virtual-host-style requests
     * (e.g. `bucket.s3.<region>.amazonaws.com`). Default: `"amazonaws.com"`.
     */
    serviceEndpoint?: string;
    /** Access key id clients must sign requests with. Default: `"S3TEST"`. */
    accessKeyId?: string;
    /** Secret access key clients must sign requests with. Default: `"S3TEST"`. */
    secretAccessKey?: string;
    /** Region reported in responses and event records. Default: `"us-east-1"`. */
    region?: string;
    /** Buckets to create (and configure) before the server starts. */
    configureBuckets?: BucketConfiguration[];
  }

  type ResolvedOptions = S3TestServerOptions &
    Required<
      Pick<
        S3TestServerOptions,
        | 'address'
        | 'port'
        | 'silent'
        | 'resetOnClose'
        | 'allowMismatchedSignatures'
        | 'vhostBuckets'
        | 'serviceEndpoint'
        | 'accessKeyId'
        | 'secretAccessKey'
        | 'region'
      >
    >;

  interface RunAddress {
    /** Bound address, as reported by `net.Server#address()`. */
    address: string;
    family: string;
    port: number;
    /** `"http"` or `"https"`. */
    protocol: string;
    /** Convenience endpoint URL, e.g. `"http://localhost:4568"`. */
    endpoint: string;
  }

  type S3EventName =
    | 'ObjectCreated:Put'
    | 'ObjectCreated:Copy'
    | 'ObjectCreated:Post'
    | 'ObjectCreated:CompleteMultipartUpload'
    | 'ObjectRemoved:Delete';

  interface S3EventRecord {
    eventVersion: string;
    eventSource: 'aws:s3';
    awsRegion: string;
    eventTime: string;
    eventName: S3EventName;
    userIdentity: { principalId: string };
    requestParameters: { sourceIPAddress: string };
    responseElements: Record<string, string>;
    s3: {
      s3SchemaVersion: string;
      configurationId: string;
      bucket: {
        name: string;
        ownerIdentity: { principalId: string };
        arn: string;
      };
      object: {
        /** URL-encoded object key. */
        key: string;
        size: number;
        eTag?: string;
        sequencer: string;
      };
    };
  }

  interface S3EventNotification {
    Records: S3EventRecord[];
  }

  type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

  class S3Error extends Error {
    code: string;
    statusCode: number;
    detail: Record<string, unknown>;
  }

  export {
    S3TestServer,
    BucketConfiguration,
    S3TestServerOptions,
    ResolvedOptions,
    RunAddress,
    S3EventName,
    S3EventRecord,
    S3EventNotification,
    RequestHandler,
    S3Error,
  };
}

export = S3TestServer;
