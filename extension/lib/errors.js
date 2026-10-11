// Shared error type for every speech engine (free, Azure and device voices).
export class SpeechError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
  }
}
