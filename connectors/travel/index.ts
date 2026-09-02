import {
  GatewayError,
  type ConnectorExecution,
  type SiteConnector,
} from "../../lib/gateway-runtime";

export const travelConnector: SiteConnector = {
  provider: "travel",
  async execute(): Promise<ConnectorExecution> {
    throw new GatewayError("PROVIDER_UNSUPPORTED", "Travel search is not available through a zero-configuration public route.", {
      retryable: false,
      mode: "public_http",
      stage: "http",
    });
  },
};
