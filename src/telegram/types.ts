// Minimal subset of the Telegram Bot API types this bot reads.
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  is_forum?: boolean;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

export interface TgContact {
  phone_number: string;
  first_name?: string;
  user_id?: number;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  sender_chat?: TgChat;
  chat: TgChat;
  date?: number;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  video?: TgFile;
  document?: TgFile;
  voice?: TgFile;
  audio?: TgFile;
  animation?: TgFile;
  video_note?: TgFile;
  sticker?: TgFile;
  contact?: TgContact;
  media_group_id?: string;
  reply_to_message?: { message_id: number; message_thread_id?: number };
  forum_topic_created?: unknown;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface ReplyMarkup {
  [key: string]: unknown;
}

/** The subset of the Bot API this app uses; tests provide a fake implementation. */
export interface TelegramApi {
  sendMessage(args: {
    chatId: string;
    text: string;
    messageThreadId?: string | null;
    replyToMessageId?: string | null;
    replyMarkup?: ReplyMarkup;
  }): Promise<{ messageId: string }>;
  copyMessage(args: {
    toChatId: string;
    fromChatId: string;
    messageId: string;
    messageThreadId?: string | null;
    replyToMessageId?: string | null;
  }): Promise<{ messageId: string }>;
  createForumTopic(args: { chatId: string; name: string }): Promise<{ messageThreadId: string }>;
  editForumTopic(args: { chatId: string; messageThreadId: string; name: string }): Promise<void>;
  closeForumTopic(args: { chatId: string; messageThreadId: string }): Promise<void>;
  reopenForumTopic(args: { chatId: string; messageThreadId: string }): Promise<void>;
}
