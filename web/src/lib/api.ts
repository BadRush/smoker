import createClient from "openapi-fetch";
import type { components, paths } from "./api-schema";

export type Probe = components["schemas"]["Probe"];
export type CreateProbeResponse = components["schemas"]["CreateProbeResponse"];
export type TargetGroup = components["schemas"]["TargetGroup"];
export type Target = components["schemas"]["Target"];
export type TargetInput = components["schemas"]["TargetInput"];
export type SparkPoint = components["schemas"]["SparkPoint"];
export type MatrixCell = components["schemas"]["MatrixCell"];
export type MatrixSnapshot = components["schemas"]["MatrixSnapshot"];
export type ProbeSeries = components["schemas"]["ProbeSeries"];
export type TargetSeriesResponse = components["schemas"]["TargetSeriesResponse"];
export type BatchSeriesResponse = components["schemas"]["BatchSeriesResponse"];
export type MTRSnapshot = components["schemas"]["MTRSnapshot"];
export type MTRHop = components["schemas"]["MTRHop"];
export type AlertRule = components["schemas"]["AlertRule"];
export type AlertRuleInput = components["schemas"]["AlertRuleInput"];
export type AlertChannel = components["schemas"]["AlertChannel"];
export type AlertChannelInput = components["schemas"]["AlertChannelInput"];
export type AlertChannelUpdateInput = components["schemas"]["AlertChannelUpdateInput"];
export type Incident = components["schemas"]["Incident"];
export type SystemSettings = components["schemas"]["SystemSettings"];
export type SessionInfo = components["schemas"]["SessionInfo"];
export type TVPreset = components["schemas"]["TVPreset"];
export type TVPresetInput = components["schemas"]["TVPresetInput"];

export class ApiError extends Error {
  status: number;
  detail: string;
  requestId?: string;

  constructor(status: number, detail: string, requestId?: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.requestId = requestId;
  }
}

export const client = createClient<paths>({
  baseUrl: "/",
  credentials: "include",
});

export async function apiRequest<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { detail: text };
    }
  }

  if (!res.ok) {
    const detail =
      typeof parsed.detail === "string"
        ? parsed.detail
        : typeof parsed.title === "string"
        ? parsed.title
        : `HTTP ${res.status}`;
    const reqId =
      typeof parsed.request_id === "string" ? parsed.request_id : undefined;
    throw new ApiError(res.status, detail, reqId);
  }

  return parsed as T;
}
