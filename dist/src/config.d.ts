export type UniversalCaptureConfig = {
    folder: string;
    timezone: string;
    rolloverTime: string;
    skipNoReply: boolean;
};
export declare function parseConfig(raw: unknown): UniversalCaptureConfig;
