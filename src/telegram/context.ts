import type { Store } from '../database/store';
import type { StaffAuth } from '../security/staff-auth';
import type { Logger } from '../utils/logging';
import type { TelegramApi } from './types';

export interface BotContext {
  store: Store;
  telegram: TelegramApi;
  staffAuth: StaffAuth;
  staffGroupId: string;
  botUsername: string;
  logger: Logger;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Update currently being processed (for persistence / structured logs). */
  updateId: string;
}
