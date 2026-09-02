import {
  GatewayError,
  type ConnectorExecution,
  type SiteConnector,
} from "../../lib/gateway-runtime";

export const railConnector: SiteConnector = {
  provider: "rail",
  async execute(): Promise<ConnectorExecution> {
    throw new GatewayError("PROVIDER_UNSUPPORTED", "UK rail is not available through a zero-configuration public route.", {
      retryable: false,
      mode: "public_http",
      stage: "http",
    });
  },
};
