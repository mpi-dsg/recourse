export interface CloudParameter {
  name: string;
  value: string;
  version?: number;
}

export interface CloudClient {
  getParameter(name: string): Promise<CloudParameter | null>;
  putParameter(name: string, value: string): Promise<CloudParameter>;
  deleteParameter(name: string): Promise<void>;
}

export class CloudClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudClientError";
  }
}

const PARAMETER_NAME_RE = /^\/?[A-Za-z0-9_.\-/]+$/;

export function assertCloudParameterName(name: string): void {
  if (!PARAMETER_NAME_RE.test(name) || name.length === 0 || name.length > 256) {
    throw new CloudClientError(`invalid cloud parameter name: ${name}`);
  }
}
