import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client, ChannelType } from 'discord.js';
import * as config from '../core/config.js';
import * as session from '../core/session.js';
import { startDiscordBot, stopDiscordBot } from './discord.js';

vi.mock('discord.js', () => {
  const mockLogin = vi.fn().mockResolvedValue('token-verified');
  const mockDestroy = vi.fn();
  const mockOn = vi.fn();
  const mockOnce = vi.fn();
  const mockUser = { id: 'bot-123', tag: 'zedda-bot#1234' };

  class MockClient {
    once = mockOnce;
    on = mockOn;
    login = mockLogin;
    destroy = mockDestroy;
    user = mockUser;
  }

  (globalThis as any).mockLogin = mockLogin;
  (globalThis as any).mockDestroy = mockDestroy;
  (globalThis as any).mockOn = mockOn;
  (globalThis as any).mockOnce = mockOnce;

  return {
    Client: MockClient,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: {
      Channel: 1,
      Message: 2,
    },
    ChannelType: {
      DM: 1,
      GuildText: 0,
    },
  };
});

vi.mock('../core/config.js');
vi.mock('../core/session.js');

describe('discord adapter', () => {
  const mockConfig = {
    adapters: {
      discord: {
        enabled: true,
        allowed_users: ['user-allowed'],
        primary_user: 'user-allowed',
      },
    },
  };

  let mockLogin: any;
  let mockDestroy: any;
  let mockOn: any;
  let mockOnce: any;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DISCORD_BOT_TOKEN = 'secret-bot-token';
    vi.spyOn(config, 'loadConfig').mockReturnValue(mockConfig);

    mockLogin = (globalThis as any).mockLogin;
    mockDestroy = (globalThis as any).mockDestroy;
    mockOn = (globalThis as any).mockOn;
    mockOnce = (globalThis as any).mockOnce;
  });

  afterEach(async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    await stopDiscordBot();
  });

  describe('startDiscordBot lifecycle', () => {
    it('does not start bot if disabled in config', async () => {
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        adapters: { discord: { enabled: false, allowed_users: [], primary_user: '' } },
      });

      await startDiscordBot();

      expect(mockLogin).not.toHaveBeenCalled();
    });

    it('does not start bot if DISCORD_BOT_TOKEN is missing', async () => {
      delete process.env.DISCORD_BOT_TOKEN;
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await startDiscordBot();

      expect(mockLogin).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('DISCORD_BOT_TOKEN environment variable is not defined'));
    });

    it('creates and logs in client successfully', async () => {
      await startDiscordBot();

      expect(mockLogin).toHaveBeenCalledWith('secret-bot-token');
      expect(mockOnce).toHaveBeenCalledWith('ready', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    });
  });

  describe('messageCreate event handling', () => {
    let messageHandler: (msg: any) => Promise<void>;
    let mockSessionObj: any;

    beforeEach(async () => {
      await startDiscordBot();
      // Retrieve the messageCreate listener callback registered
      const messageCreateCall = mockOn.mock.calls.find((call: any) => call[0] === 'messageCreate');
      expect(messageCreateCall).toBeDefined();
      messageHandler = messageCreateCall[1];

      // Setup session mock
      mockSessionObj = {
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn((cb) => {
          // Instantly trigger mock assistant response delta
          cb({
            type: 'message_update',
            assistantMessageEvent: {
              type: 'text_delta',
              delta: 'Hello from agent!',
            },
          });
          return vi.fn(); // unsubscribe
        }),
      };
      vi.spyOn(session, 'getOrCreateSession').mockResolvedValue(mockSessionObj);
    });

    it('ignores message if sender is a bot', async () => {
      const mockMsg = {
        author: { bot: true, id: 'user-allowed' },
        reply: vi.fn(),
      };

      await messageHandler(mockMsg);

      expect(session.getOrCreateSession).not.toHaveBeenCalled();
    });

    it('ignores message if sender is not allowed', async () => {
      const mockMsg = {
        author: { bot: false, id: 'unauthorized-user' },
        reply: vi.fn(),
      };

      await messageHandler(mockMsg);

      expect(session.getOrCreateSession).not.toHaveBeenCalled();
    });

    it('ignores server message if bot is not mentioned (passive behavior)', async () => {
      const mockMsg = {
        author: { bot: false, id: 'user-allowed' },
        channel: { id: 'chan-1', type: ChannelType.GuildText },
        mentions: { users: { has: vi.fn().mockReturnValue(false) } }, // not mentioned
        reply: vi.fn(),
      };

      await messageHandler(mockMsg);

      expect(session.getOrCreateSession).not.toHaveBeenCalled();
    });

    it('responds in DMs without needing mention', async () => {
      const replySpy = vi.fn().mockResolvedValue(undefined);
      const sendTypingSpy = vi.fn().mockResolvedValue(undefined);
      const mockMsg = {
        author: { bot: false, id: 'user-allowed', username: 'partner' },
        channel: { id: 'chan-dm', type: ChannelType.DM, sendTyping: sendTypingSpy },
        content: 'Hi bot!',
        mentions: { users: { has: vi.fn().mockReturnValue(false) } },
        reply: replySpy,
      };

      await messageHandler(mockMsg);

      expect(session.getOrCreateSession).toHaveBeenCalledWith('chan-dm');
      expect(mockSessionObj.prompt).toHaveBeenCalledWith('Hi bot!');
      expect(sendTypingSpy).toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledWith('Hello from agent!');
    });

    it('responds in server channel when mentioned and strips mention from content', async () => {
      const replySpy = vi.fn().mockResolvedValue(undefined);
      const mockMsg = {
        author: { bot: false, id: 'user-allowed', username: 'partner' },
        channel: { id: 'chan-guild', type: ChannelType.GuildText },
        content: '<@bot-123> run check',
        mentions: { users: { has: vi.fn().mockImplementation((id) => id === 'bot-123') } },
        reply: replySpy,
      };

      await messageHandler(mockMsg);

      expect(session.getOrCreateSession).toHaveBeenCalledWith('chan-guild');
      expect(mockSessionObj.prompt).toHaveBeenCalledWith('run check'); // mention stripped
      expect(replySpy).toHaveBeenCalledWith('Hello from agent!');
    });

    it('handles chunking of responses exceeding 2000 characters', async () => {
      // Setup session mock to return a very long message (e.g. 2050 characters)
      const longMessage = 'A'.repeat(2050);
      mockSessionObj.subscribe = vi.fn((cb) => {
        cb({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: longMessage,
          },
        });
        return vi.fn();
      });

      const replySpy = vi.fn().mockResolvedValue(undefined);
      const mockMsg = {
        author: { bot: false, id: 'user-allowed', username: 'partner' },
        channel: { id: 'chan-dm', type: ChannelType.DM },
        content: 'tell me a story',
        mentions: { users: { has: vi.fn().mockReturnValue(false) } },
        reply: replySpy,
      };

      await messageHandler(mockMsg);

      // Verify that it split the response and replied twice
      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[0]?.[0]?.length).toBe(2000);
      expect(replySpy.mock.calls[1]?.[0]?.length).toBe(50);
    });
  });
});
