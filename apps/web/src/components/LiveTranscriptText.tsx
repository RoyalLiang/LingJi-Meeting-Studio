export function LiveTranscriptText({ text }: { text: string }) {
  return <span data-live-text>{text}<span className="live-caret" aria-hidden="true" /></span>;
}
