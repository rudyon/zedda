import { Client, GatewayIntentBits, Partials, ChannelType, Message } from 'discord.js';
import { loadConfig } from '../core/config.js';
import { getOrCreateSession } from '../core/session.js';

let client: Client | null = null;

// Split text into chunks of at most 2000 characters
function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let currentChunk = '';

  const lines = text.split('\n');
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      if (line.length > maxLength) {
        let tempLine = line;
        while (tempLine.length > maxLength) {
          chunks.push(tempLine.slice(0, maxLength));
          tempLine = tempLine.slice(maxLength);
        }
        currentChunk = tempLine;
      } else {
        currentChunk = line;
      }
    } else {
      if (currentChunk) {
        currentChunk += '\n' + line;
      } else {
        currentChunk = line;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }
  return chunks;
}

// Starts the Discord bot using configuration
export async function startDiscordBot(): Promise<void> {
  const config = loadConfig();
  if (!config.adapters?.discord?.enabled) {
    console.log('[Discord] Bot is disabled in config.toml.');
    return;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[Discord] Error: DISCORD_BOT_TOKEN environment variable is not defined.');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [
      Partials.Channel,
      Partials.Message
    ]
  });

  client.once('clientReady', () => {
    console.log(`[Discord] Bot is logged in as ${client?.user?.tag}`);
  });

  client.on('messageCreate', async (message: Message) => {
    // 1. Ignore bots
    if (message.author.bot) return;

    // 2. Access control (allowed_users check)
    const allowedUsers = config.adapters?.discord?.allowed_users || [];
    if (!allowedUsers.includes(message.author.id)) {
      return; // Silently ignore unauthorized users
    }

    // 3. Trigger condition
    const isDM = message.channel.type === ChannelType.DM;
    const isMentioned = client?.user && message.mentions.users.has(client.user.id);
    
    if (!isDM && !isMentioned) {
      return; // Passive in servers: trigger only on explicit mentions
    }

    console.log(`[Discord] Message received in channel ${message.channel.id} from ${message.author.username}`);

    // Remove bot mention from content if mentioned in a server
    let cleanPrompt = message.content;
    if (client?.user && isMentioned) {
      const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
      cleanPrompt = cleanPrompt.replace(mentionRegex, '').trim();
    }

    // 4. Retrieve or create session for the channel
    let session;
    try {
      session = await getOrCreateSession(message.channel.id);
    } catch (err) {
      console.error('[Discord] Error initializing session:', err);
      await message.reply('Sorry, I encountered an error initializing our session context.');
      return;
    }

    // 5. Send typing indicator periodically
    const channel = message.channel as any;
    if (typeof channel.sendTyping === 'function') {
      await channel.sendTyping();
    }
    const typingInterval = setInterval(() => {
      if (typeof channel.sendTyping === 'function') {
        channel.sendTyping().catch(() => {});
      }
    }, 5000);

    // 6. Prompt the agent and collect response
    let responseText = '';
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        responseText += event.assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(cleanPrompt);
    } catch (err) {
      console.error('[Discord] Error executing agent prompt:', err);
      responseText = responseText || 'Sorry, I encountered an error generating my response.';
    } finally {
      clearInterval(typingInterval);
      unsubscribe();
    }

    // 7. Reply with chunking
    if (!responseText.trim()) {
      responseText = '...';
    }

    const chunks = splitMessage(responseText);
    try {
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (err) {
      console.error('[Discord] Error replying to message:', err);
    }
  });

  await client.login(token);
}

// Gracefully shuts down the Discord client
export async function stopDiscordBot(): Promise<void> {
  if (client) {
    console.log('[Discord] Logging out Discord bot...');
    client.destroy();
    client = null;
  }
}
