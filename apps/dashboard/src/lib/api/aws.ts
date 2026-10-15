import { api } from "./client";
export interface AwsSiteInput {
  name: string;
  domains?: { hostname: string; hostedZoneId?: string }[];
  domain?: string;
  hostedZoneId?: string;
  spa?: boolean;
}
export interface AwsSite {
  name: string;
  status: string;
  configuration?: AwsSiteInput;
  outputs?: Record<string, string>;
  certificateStatus?: string;
  validationRecords?: { Name: string; Type: string; Value: string }[];
  resources?: { logicalId: string; id?: string; status: string }[];
  events?: { resource: string; status: string; time: string }[];
}
const base = (account: string) => `/aws/${encodeURIComponent(account)}/sites`;
export const awsApi = {
  list: (account: string) => api.get<{ data: AwsSite[] }>(base(account)),
  get: (account: string, name: string) =>
    api.get<{ data: AwsSite }>(`${base(account)}/${encodeURIComponent(name)}`),
  create: (account: string, input: AwsSiteInput) => api.post(base(account), input),
  update: (account: string, input: AwsSiteInput) => api.put(base(account), input),
  remove: (account: string, name: string) =>
    api.delete(`${base(account)}/${encodeURIComponent(name)}`),
  invalidate: (account: string, name: string) =>
    api.post(`${base(account)}/${encodeURIComponent(name)}/invalidate`, {}),
};
