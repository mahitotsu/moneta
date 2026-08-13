// Wire-format types mirror web-ui/src/api/types.ts's AccountNumberLookup exactly (same backend
// contract, docs/adr/0015). Kept as a separate copy for the same reason httpClient.ts's types
// are: this harness talks to the raw API Gateway URL, not the CloudFront-proxied relative path.
import { authHeaders, rawRequest } from "./httpClient";

export interface AccountNumberLookup {
  accountId: string;
  ownerId: string;
  accountNumber: string;
  branchCode: string;
  branchName: string;
}

export interface AccountNumberApi {
  lookupByNumber(accountNumber: string): Promise<AccountNumberLookup | null>;
  lookupByAccountId(accountId: string): Promise<AccountNumberLookup | null>;
}

// `idToken`(docs/adr/0016決定2、AccountNumberQueryApiも認証必須)は省略可能——省略時は
// 無認証でリクエストし、401検証に使える(httpClient.tsのcreateQueryApiと同じ形)。
export function createAccountNumberApi(baseUrl: string, idToken?: string): AccountNumberApi {
  return {
    lookupByNumber: async (accountNumber) => {
      const response = await rawRequest<AccountNumberLookup>(`${baseUrl}/account-numbers/${accountNumber}`, {
        headers: authHeaders(idToken),
      });
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(
          `lookupByNumber(${accountNumber}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`,
        );
      }
      return response.body;
    },
    lookupByAccountId: async (accountId) => {
      const response = await rawRequest<AccountNumberLookup>(`${baseUrl}/accounts/${accountId}/account-number`, {
        headers: authHeaders(idToken),
      });
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(
          `lookupByAccountId(${accountId}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`,
        );
      }
      return response.body;
    },
  };
}
