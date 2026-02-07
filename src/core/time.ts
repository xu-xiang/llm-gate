const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

// NOTE: Always derive Beijing time from UTC timestamp to avoid node-local timezone drift.
function beijingIsoNow(): string {
    return new Date(Date.now() + BEIJING_OFFSET_MS).toISOString();
}

export function getBeijingDate(): string {
    return beijingIsoNow().slice(0, 10);
}

export function getBeijingMinuteBucket(): string {
    return beijingIsoNow().slice(0, 16);
}

