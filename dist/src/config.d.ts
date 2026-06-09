export type UniversalCaptureConfig = {
    folder: string;
    recallFolder: string;
    recallTurns: number;
    recallMaxBytes: number;
    timezone: string;
    rolloverTime: string;
    skipNoReply: boolean;
    includeMessageMetadata: boolean;
    stripUntrustedMetadata: boolean;
    agents: CaptureFilter;
    surfaces: CaptureFilter;
    channels: CaptureFilter;
};
export type CaptureFilter = {
    mode: "all" | "include" | "exclude";
    values: Set<string>;
};
export declare function parseConfig(raw: unknown): UniversalCaptureConfig;
