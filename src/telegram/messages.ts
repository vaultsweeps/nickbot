import type { TgMessage } from './types';

export type SupportedType = 'text' | 'photo' | 'video' | 'document' | 'voice';

export interface Classified {
  type: SupportedType;
  text: string | null;
  caption: string | null;
  fileId: string | null;
  fileUniqueId: string | null;
}

/**
 * Classifies a message into one of the supported kinds. Returns null for service messages,
 * contacts and unsupported media (audio, stickers, video notes, animations, ...).
 * Photos use the largest size; media is later re-sent with copyMessage, never downloaded.
 */
export function classifyMessage(m: TgMessage): Classified | null {
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1]!;
    return {
      type: 'photo',
      text: null,
      caption: m.caption ?? null,
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
    };
  }
  const media = (['video', 'document', 'voice'] as const).find((k) => m[k]);
  if (media) {
    const f = m[media]!;
    return {
      type: media,
      text: null,
      caption: m.caption ?? null,
      fileId: f.file_id,
      fileUniqueId: f.file_unique_id,
    };
  }
  if (m.audio || m.animation || m.video_note || m.sticker || m.contact) return null;
  if (typeof m.text === 'string' && m.text.length > 0) {
    return { type: 'text', text: m.text, caption: null, fileId: null, fileUniqueId: null };
  }
  return null;
}

export const isUnsupportedMedia = (m: TgMessage): boolean =>
  Boolean(m.audio || m.animation || m.video_note || m.sticker);

export const texts = {
  welcome: (name: string) =>
    `Hello${name ? `, ${name}` : ''}! 👋 You're connected to our support team.\n\n` +
    `Just write your message here — text, photos, videos, documents or voice messages all work, ` +
    `and we'll reply in this chat.\n\n` +
    `Optional: tap the button below to share your phone number so we can identify you more easily. ` +
    `You can skip it and simply start typing.`,
  contactThanks: 'Thanks, your phone number was saved. You can keep writing here whenever you like.',
  contactNotOwn: 'Please share your own contact using the button — contacts of other people cannot be used.',
  received: (ticket: number) =>
    `✅ We received your message (ticket #${ticket}). Our team will reply here soon.`,
  unsupported:
    'Sorry, this type of message is not supported. Please send text, a photo, a video, a document or a voice message.',
  deliveryFailed:
    'Sorry, we could not pass your message to our team right now. Please try again in a few minutes.',
  tryLater: 'Something went wrong on our side. Please try again in a moment.',
};
