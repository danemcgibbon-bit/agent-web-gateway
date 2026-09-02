import {
  GatewayError,
  type ConnectorExecution,
  type SiteConnector,
} from "../../lib/gateway-runtime";

export const ebayConnector: SiteConnector = {
  provider: "ebay",
  async execute(): Promise<ConnectorExecution> {
    throw new GatewayError("PROVIDER_UNSUPPORTED", "eBay is not available through a zero-configuration public route.", {
      retryable: false,
      mode: "public_http",
      stage: "http",
    });
  },
};
