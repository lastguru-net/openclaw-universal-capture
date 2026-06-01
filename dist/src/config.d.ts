export type UniversalCaptureConfig = {
    folder: string;
    timezone: string;
    skipNoReply: boolean;
};
export declare function parseConfig(raw: unknown): UniversalCaptureConfig;
