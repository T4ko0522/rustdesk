import { CredentialError } from './service.js';
import type { CredentialService } from './service.js';
import { AccessError } from './access.js';
import type { AccessService } from './access.js';
import { commandActionSchema, discordUserSchema } from './schemas.js';
import { Client, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction, InteractionDeferReplyOptions, InteractionEditReplyOptions, InteractionReplyOptions, MessageMentionOptions } from 'discord.js';

const ephemeral = MessageFlags.Ephemeral;
const mentions: MessageMentionOptions = { parse: [] };
const failure = '処理に失敗しました。時間をおいて再試行してください。';

// A small Discord-derived interface keeps injected interactions testable.
export interface CommandInteraction extends Pick<ChatInputCommandInteraction, 'commandName' | 'guildId'> {
  user: Pick<ChatInputCommandInteraction['user'], 'id'>;
  options: {
    getString(name: string): string | null;
    getUser(name: string, required: true): Pick<ChatInputCommandInteraction['user'], 'id'>;
  };
  isChatInputCommand(): boolean;
  reply(options: InteractionReplyOptions): Promise<unknown>;
  deferReply(options: InteractionDeferReplyOptions): Promise<unknown>;
  editReply(options: InteractionEditReplyOptions): Promise<unknown>;
  deleteReply(): Promise<unknown>;
}
export type Schedule = (callback: () => Promise<void>, delay: number) => Pick<NodeJS.Timeout, 'unref'> | undefined;

export function createInteractionHandler({ service, access, schedule = setTimeout }: {
  service: CredentialService;
  access: AccessService;
  schedule?: Schedule;
}) {
  return async function handleInteraction(interaction: CommandInteraction): Promise<void> {
    if (!interaction.isChatInputCommand() || !['rustdesk', 'add'].includes(interaction.commandName)) {
      return;
    }

    let deferred = false;
    try {
      const identity = { userId: interaction.user.id, guildId: interaction.guildId };
      const adding = interaction.commandName === 'add';
      if (!(adding ? access.canManage(identity) : service.authorize(identity))) {
        await interaction.reply({
          content: 'この操作は許可されていません。',
          flags: ephemeral,
          allowedMentions: mentions,
        });
        return;
      }

      if (adding) {
        const user = discordUserSchema.parse(interaction.options.getUser('user', true));
        await interaction.deferReply({ flags: ephemeral });
        deferred = true;
        const result = await access.add(identity, user.id);
        await interaction.editReply({
          content: result === 'added' ? '指定したユーザーに RustDesk の実行権限を追加しました。' : '指定したユーザーにはすでに RustDesk の実行権限があります。',
          allowedMentions: mentions,
        });
        return;
      }

      const action = commandActionSchema.parse(interaction.options.getString('action'));
      await interaction.deferReply({ flags: ephemeral });
      deferred = true;
      const credentials = action === 'rotate' ? await service.rotate(identity) : await service.get(identity);
      // Start expiry before sending: a network failure can still leave a delivered reply.
      const timer = schedule(async () => {
        try {
          await interaction.deleteReply();
        } catch {}
      }, 60000);
      timer?.unref?.();
      await interaction.editReply({
        content: 'RustDesk ID: ' + credentials.id +
          '\nPassword: ' + credentials.password +
          '\nこの返信は約60秒後に削除します。',
        allowedMentions: mentions,
      });
    } catch (error) {
      const content = error instanceof CredentialError || error instanceof AccessError ? error.message : failure;
      try {
        if (deferred) {
          await interaction.editReply({ content, allowedMentions: mentions });
        } else {
          await interaction.reply({ content, flags: ephemeral, allowedMentions: mentions });
        }
      } catch {}
    }
  };
}

export function createRustDeskCommand() {
  return new SlashCommandBuilder()
    .setName('rustdesk')
    .setDescription('RustDesk の現在の ID と一時パスワードを取得します')
    .addStringOption(option => option
      .setName('action')
      .setDescription('rotate を指定すると一時パスワードを更新して取得します')
      .setRequired(false)
      .addChoices({ name: 'rotate', value: 'rotate' }));
}

export function createAddCommand() {
  return new SlashCommandBuilder()
    .setName('add')
    .setDescription('指定したユーザーに RustDesk の実行権限を追加します')
    .addUserOption(option => option.setName('user').setDescription('実行権限を追加するユーザー').setRequired(true));
}

export async function startDiscordBot({ token, guildId, service, access }: {
  token: string;
  guildId: string;
  service: CredentialService;
  access: AccessService;
}): Promise<Client> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: mentions,
  });
  client.on(Events.Error, () => console.error('Discord connection error.'));
  client.on(Events.ShardError, () => console.error('Discord gateway error.'));
  const handleInteraction = createInteractionHandler({ service, access });
  client.on(Events.InteractionCreate, interaction => {
    if (interaction.isChatInputCommand()) void handleInteraction(interaction);
  });
  client.once(Events.ClientReady, async readyClient => {
    try {
      const guild = await client.guilds.fetch(guildId);
      const commands = await guild.commands.fetch();
      // Update only our commands; preserve unrelated guild commands.
      for (const command of [createRustDeskCommand(), createAddCommand()]) {
        const existing = commands.find(item => item.name === command.name);
        if (existing) {
          await guild.commands.edit(existing.id, command.toJSON());
        } else {
          await guild.commands.create(command.toJSON());
        }
      }
      console.info(`RustDesk Discord bot ready. Bot: ${readyClient.user.displayName}`);
    } catch {
      console.error('Discord command registration failed.');
      client.destroy();
      process.exitCode = 1;
    }
  });

  try {
    await client.login(token);
  } catch {
    client.destroy();
    throw new Error('Discord login failed.');
  }
  return client;
}
