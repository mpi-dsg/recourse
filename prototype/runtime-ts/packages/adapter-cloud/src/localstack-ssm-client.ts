import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
  type ParameterType,
} from "@aws-sdk/client-ssm";
import {
  CloudClientError,
  assertCloudParameterName,
  type CloudClient,
  type CloudParameter,
} from "./cloud-client.ts";

export interface LocalStackSsmClientConfig {
  endpoint: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  parameterType?: ParameterType;
}

export class LocalStackSsmCloudClient implements CloudClient {
  private readonly client: SSMClient;
  private readonly parameterType: ParameterType;

  constructor(cfg: LocalStackSsmClientConfig) {
    this.client = new SSMClient({
      endpoint: cfg.endpoint,
      region: cfg.region ?? "us-east-1",
      credentials: {
        accessKeyId: cfg.accessKeyId ?? "test",
        secretAccessKey: cfg.secretAccessKey ?? "test",
      },
    });
    this.parameterType = cfg.parameterType ?? "String";
  }

  async getParameter(name: string): Promise<CloudParameter | null> {
    assertCloudParameterName(name);
    try {
      const result = await this.client.send(new GetParameterCommand({ Name: name }));
      const param = result.Parameter;
      if (!param || param.Value === undefined) return null;
      return {
        name,
        value: param.Value,
        ...(param.Version !== undefined ? { version: param.Version } : {}),
      };
    } catch (error) {
      if (error instanceof ParameterNotFound) return null;
      throw new CloudClientError(this.errorMessage(error));
    }
  }

  async putParameter(name: string, value: string): Promise<CloudParameter> {
    assertCloudParameterName(name);
    try {
      const result = await this.client.send(
        new PutParameterCommand({
          Name: name,
          Value: value,
          Type: this.parameterType,
          Overwrite: true,
        }),
      );
      return {
        name,
        value,
        ...(result.Version !== undefined ? { version: result.Version } : {}),
      };
    } catch (error) {
      throw new CloudClientError(this.errorMessage(error));
    }
  }

  async deleteParameter(name: string): Promise<void> {
    assertCloudParameterName(name);
    try {
      await this.client.send(new DeleteParameterCommand({ Name: name }));
    } catch (error) {
      if (error instanceof ParameterNotFound) return;
      throw new CloudClientError(this.errorMessage(error));
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
