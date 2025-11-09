// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, Events } = require('discord.js');
const mongoose = require('mongoose');
const winston = require('winston');

const Ptero = require('./ptero');
const { encrypt, decrypt } = require('./utils/crypto');
const createCmd = require('./commands/create');
const panelCmd = require('./commands/panel');
const ServerModel = require('./models/Server');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports: [new winston.transports.Console({ format: winston.format.simple() })]
});

// sanity checks
if (!process.env.DISCORD_TOKEN) logger.warn('DISCORD_TOKEN not set in .env');
if (!process.env.CLIENT_ID) logger.warn('CLIENT_ID not set in .env');
if (!process.env.MONGO_URI) logger.warn('MONGO_URI not set in .env');
if (!process.env.PTERO_URL) logger.warn('PTERO_URL not set in .env');
if (!process.env.PTERO_APP_KEY) logger.warn('PTERO_APP_KEY not set in .env');
if (!process.env.CREDENTIALS_ENCRYPTION_KEY) logger.warn('CREDENTIALS_ENCRYPTION_KEY not set in .env or is insecure');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// prepare commands
const commands = [createCmd.data.toJSON(), panelCmd.data.toJSON()];
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      logger.info('Registered guild commands');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      logger.info('Registered global commands');
    }
  } catch (err) {
    logger.error('Command registration failed', err);
  }
}

let ptero;
try {
  ptero = new Ptero({ url: process.env.PTERO_URL, applicationKey: process.env.PTERO_APP_KEY });
} catch (err) {
  logger.error('Pterodactyl wrapper init failed', err);
  process.exit(1);
}

client.once(Events.ClientReady, () => {
  logger.info(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'create') {
        return createCmd.execute(interaction, { ptero, encrypt, logger });
      } else if (interaction.commandName === 'panel') {
        return panelCmd.execute(interaction, { decrypt, logger });
      }
    } else if (interaction.isButton()) {
      const cid = interaction.customId;
      if (!cid.startsWith('view_login_')) return;
      await interaction.deferReply({ ephemeral: true });
      const dbId = cid.replace('view_login_', '');
      const server = await ServerModel.findById(dbId).lean();
      if (!server) return interaction.editReply({ content: 'Server not found.', ephemeral: true });

      const adminIds = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
      const isOwner = interaction.user.id === server.discordOwnerId;
      const isAdmin = adminIds.includes(interaction.user.id);
      if (!isOwner && !isAdmin) {
        return interaction.editReply({ content: 'You are not allowed to view these credentials.', ephemeral: true });
      }

      const password = decrypt(server.encryptedPassword, process.env.CREDENTIALS_ENCRYPTION_KEY);
      const msg = `**Panel URL:** ${process.env.PTERO_URL}\n**Email/Username:** ${server.pteroEmail}\n**Password:** ${password}\n**Server Name:** ${server.serverName}\n\n_This message is only visible to you._`;
      return interaction.editReply({ content: msg, ephemeral: true });
    }
  } catch (err) {
    logger.error('interaction error', err?.response?.data || err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'An error occurred.' });
      else await interaction.reply({ content: 'An error occurred.', ephemeral: true });
    } catch (e) { logger.error('reply failed', e); }
  }
});

// startup
(async () => {
  try {
    // connect to DB
    await mongoose.connect(process.env.MONGO_URI, { keepAlive: true });
    logger.info('MongoDB connected');

    // register slash commands
    await registerCommands();

    // login to Discord
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    logger.error('Startup failed', err);
    process.exit(1);
  }
})();