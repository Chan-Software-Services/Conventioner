/**
 * A transport for the error tracker's client that records every envelope it is given, so a test
 * reads exactly what would leave the browser, and nothing reaches Sentry.
 */
import { expect } from 'vitest';
import { createTransport, type Event, type Exception } from '@sentry/browser';
import type { Transport } from '@/utils/errorTrackingClient';

export interface Envelope {
  header: Record<string, unknown>;
  items: { header: { type: string }; payload: Record<string, unknown> }[];
}

/** Every envelope's body, in the order it was sent; a test empties it with `sent.length = 0`. */
export const sent: string[] = [];

export const recording: Transport = (options) =>
  createTransport(options, async (request) => {
    sent.push(
      typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body),
    );
    return { statusCode: 200 };
  });

export function envelopes(): Envelope[] {
  return sent.map((body) => {
    const [header, ...rest] = body.split('\n').filter(Boolean);
    const items: Envelope['items'] = [];
    for (let i = 0; i < rest.length; i += 2) {
      items.push({ header: JSON.parse(rest[i]!), payload: JSON.parse(rest[i + 1]!) });
    }
    return { header: JSON.parse(header!), items };
  });
}

export function events(): Event[] {
  return envelopes().flatMap((each) =>
    each.items.filter((item) => item.header.type === 'event').map((item) => item.payload as Event),
  );
}

/** The first exception an event names. */
export function firstException(event: Event): Exception {
  return event.exception!.values![0]!;
}

/** Each spelling of `value` an envelope could hold it in. */
function spellings(value: string): string[] {
  return [
    value,
    value.toLowerCase(),
    encodeURIComponent(value),
    encodeURIComponent(value).toLowerCase(),
  ];
}

/** Fails if any envelope sent holds `value`, in any spelling a URL or a lowercasing gives it. */
export function expectNowhere(value: string) {
  const everything = sent.join('\n');
  for (const spelling of spellings(value)) expect(everything).not.toContain(spelling);
}
