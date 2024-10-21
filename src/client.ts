import {
  type Awaitable,
  Client,
  Partials,
  type Snowflake,
  BaseInteraction,
  DiscordAPIError,
  RESTJSONErrorCodes,
  version,
  type RepliableInteraction,
  type ClientOptions,
  type ApplicationCommandData,
  GuildMember,
  GuildChannel,
  Role,
  ApplicationCommand,
  Collection,
  type GuildResolvable,
} from "discord.js";
import path from "node:path";
import url from "node:url";
import fileSystem from "node:fs/promises";
import {
  defineEvent,
  type ClientEvent,
  type Event,
  getEvents,
} from "./definition/events.js";
import { buttons, modals, selects } from "./definition/components.js";
import {
  NoSubcommand,
  autocompleters,
  commands,
  type DefaultCommandAccess,
} from "./definition/commands.js";
import type { MenuCommandHandler } from "./definition/commands/menu.js";
import type { SubGroupsHandler } from "./definition/commands/subGroups.js";
import type { SubcommandHandler } from "./definition/commands/subcommands.js";
import type { RootCommandHandler } from "./definition/commands/root.js";

const globalCommandKey = Symbol("global");

export let client: Client<true> = undefined as any;

export const clientCommands = {
  commandsFor: async (guildId: string) => {
    let guildCommands: ApplicationCommandData[] = [];
    await Promise.all(
      Object.entries(commands).map(async ([name, commands]) => {
        for (const command of commands) {
          const accessFunction = command.access ?? (() => true);
          if (await accessFunction(guildId)) {
            guildCommands.push({ ...command, name });
          }
        }
      }),
    );
    return guildCommands;
  },

  update: async (guildId: string) => {
    await client.application.commands.set(
      await clientCommands.commandsFor(guildId),
      guildId,
    );
  },
};

export async function login(options: LoginOptions) {
  const handleError = options.handleError ?? defaultErrorHandler;
  const [major, minor = "", patch] = version.split(".");
  if (major !== "14" || +minor < 9 || patch?.includes("-dev")) {
    process.emitWarning(
      `You are using an non-officially-supported version of discord.js (${version}). Please use version ^14.9 for maximum stability.`,
      "ExperimentalWarning",
    );
  }

  const Handler = new Client({
    allowedMentions: { parse: ["users"], repliedUser: true },
    failIfNotExists: false,
    partials: [
      Partials.User,
      Partials.Channel,
      Partials.GuildMember,
      Partials.Message,
      Partials.Reaction,
      Partials.GuildScheduledEvent,
      Partials.ThreadMember,
    ],
    ...options.clientOptions,
  });

  const readyPromise = new Promise<Client<true>>((resolve) =>
    Handler.once("ready", resolve),
  );
  Handler.on("debug", (message) => {
    if (
      process.env.NODE_ENV !== "production" ||
      !(
        message.includes("Sending a heartbeat") ||
        message.includes("Heartbeat acknowledged")
      )
    )
      if (options.debug) console.debug(message);
  })
    .on("warn", (warning) => handleError(warning, "warn"))
    .on("error", (error) => handleError(error, "error"))
    .on("invalidated", async () => {
      console.error(new ReferenceError("Session is invalid"));
      process.exit(1);
    })
    .on("guildUnavailable", async (guild) =>
      handleError(
        new ReferenceError(`Guild ${guild.name} (${guild.id}) unavailable`),
        "guildUnavailable",
      ),
    )
    .rest.on("invalidRequestWarning", (data) =>
      handleError(
        `${data.count} requests; ${data.remainingTime}ms left`,
        "invalidRequestWarning",
      ),
    )
    .on("restDebug", (message) => {
      if (
        process.env.NODE_ENV !== "production" ||
        !message.includes("Received bucket hash update")
      )
        if (options.debug) console.debug(message);
    });

  await Handler.login(options.botToken ?? process.env.BOT_TOKEN);
  client = await readyPromise;

  console.log(`Connected to Discord with tag ${client.user.tag ?? ""}`);

  if ("modulesDir" in options) {
    process.emitWarning(
      "The `modulesDir` option is deprecated. Please use `modulesDirectory` instead.",
      "DeprecationWarning",
    );
  }
  const directory = options.modulesDirectory;
  const modules = await fileSystem.readdir(directory);

  const promises = modules.map(async (module) => {
    const fullPath = path.join(directory, module);
    const resolved = (await fileSystem.lstat(fullPath)).isDirectory()
      ? path.join(fullPath, "./index.js")
      : fullPath;
    if (path.extname(resolved) !== ".js") return;
    if (options.debug) console.debug(`Loading ${module}`);
    await import(
      url.pathToFileURL(path.resolve(directory, resolved)).toString()
    );
  });
  await Promise.all(promises);
  if (options.debug) console.debug("Module Loading Done!");
  defineEvent("interactionCreate", async (interaction) => {
    if (interaction.isAutocomplete()) {
      const command = interaction.command?.name ?? "";
      const subGroup = interaction.options.getSubcommandGroup();
      const subcommand = interaction.options.getSubcommand(false);
      const option = interaction.options.getFocused(true).name;

      const autocomplete =
        autocompleters[command]?.[subGroup ?? NoSubcommand]?.[
          subcommand ?? NoSubcommand
        ]?.[option];

      if (!autocomplete) {
        throw new ReferenceError(
          `Autocomplete handler for \`/${command}${subGroup ? " " + subGroup : ""}${
            subcommand ? " " + subcommand : ""
          }\`'s \`${option}\` option not found`,
        );
      }

      return interaction.respond(autocomplete(interaction).slice(0, 25));
    }

    if (!interaction.isCommand()) {
      const [id, name] = interaction.customId.split(/(?<=^[^_]*)_/);
      if (!name) return;

      if (interaction.isButton()) await buttons[name]?.(interaction, id ?? "");
      else if (interaction.isModalSubmit())
        await modals[name]?.(interaction, id ?? "");
      else if (interaction.isAnySelectMenu())
        await selects[name]?.(interaction, id ?? "");

      return;
    }

    const { command } = commands[interaction.command?.name ?? ""]?.[0] ?? {};

    if (!command)
      throw new ReferenceError(
        `Command \`${interaction.command?.name}\` not found`,
      );

    if (interaction.isContextMenuCommand())
      await (command as MenuCommandHandler)(interaction);
    else {
      const rawOptions =
        interaction.options.data[0]?.options?.[0]?.options ??
        interaction.options.data[0]?.options ??
        interaction.options.data;

      const optionsData = rawOptions.map(
        async (option) =>
          [
            option.name,
            option.attachment ||
              (!option.channel || option.channel instanceof GuildChannel
                ? option.channel
                : await interaction.guild?.channels.fetch(option.channel.id)) ||
              (option.member instanceof GuildMember && option.member) ||
              option.user ||
              (!option.role || option.role instanceof Role
                ? option.role
                : await interaction.guild?.roles.fetch(option.role.id)) ||
              option.value,
          ] as const,
      );
      const options = Object.fromEntries(await Promise.all(optionsData));

      const subGroup = interaction.options.getSubcommandGroup();
      const subcommand = interaction.options.getSubcommand(false);
      if (subGroup && subcommand)
        await (command as SubGroupsHandler)(interaction, {
          subcommand,
          subGroup: subGroup,
          options,
        });
      else if (subcommand)
        await (command as SubcommandHandler)(interaction, {
          subcommand,
          options,
        });
      else await (command as RootCommandHandler)(interaction, options);
    }
  });

  for (const [event, execute] of Object.entries(getEvents()) as [
    ClientEvent,
    Event,
  ][]) {
    client.on(event, async (...args) => {
      try {
        await execute(...args);
      } catch (error) {
        const interaction =
          args[0] instanceof BaseInteraction && !args[0].isAutocomplete()
            ? args[0]
            : undefined;
        await handleError(error, interaction ? interaction : event);

        if (!options.commandErrorMessage) return;

        if (interaction?.deferred || interaction?.replied) {
          await interaction.followUp({
            ephemeral: true,
            content: options.commandErrorMessage,
          });
        } else if (
          Number(interaction?.createdAt) - Date.now() < 3000 &&
          !(
            error instanceof DiscordAPIError &&
            error.code === RESTJSONErrorCodes.UnknownInteraction
          )
        ) {
          await interaction?.reply({
            ephemeral: true,
            content: options.commandErrorMessage,
          });
        }
      }
    });
  }

  const guilds = await client.guilds.fetch();

  const guildCommands = await (async () => {
    const results = await Promise.all(
      Object.entries(commands).map(async ([name, commands]) => {
        const accumulator: {
          [key: Snowflake]: ApplicationCommandData[];
          [globalCommandKey]?: ApplicationCommandData[];
        } = {};

        for (const command of commands) {
          const accessFunction = command.access ?? (() => true);
         

          for (const guildId of guilds.values()) {
            
            if (await accessFunction(guildId.id)) {
              accumulator[guildId.id] ??= [];
              accumulator[guildId.id]?.push({ ...command, name });
            }
          }
        }

        return accumulator;
      }),
    );

    const finalAccumulator: {
      [key: Snowflake]: ApplicationCommandData[];
      [globalCommandKey]?: ApplicationCommandData[];
    } = {};

    for (const result of results) {
      for (const [key, value] of Object.entries(result)) {
        finalAccumulator[key] ??= [];
        finalAccumulator[key]?.push(...value);
      }
    }

    return finalAccumulator;
  })();

  await Promise.all(
    guilds.map(async (guild) => {
      const existingCommands = await client.application.commands.fetch({
        guildId: guild.id,
      });

      const newCommands = guildCommands[guild.id] ?? [];
      const commandsNeedUpdate = !compareCommands(
        existingCommands,
        newCommands,
      );

      if (commandsNeedUpdate) {
        await client.application.commands.set(newCommands, guild.id);
        if (options.debug)
          console.log(`Updated commands for guild ${guild.id}(${guild.name})`);
      } else {
        if (options.debug)
          console.log(
            `Commands for guild ${guild.id}(${guild.name}) are already up-to-date`,
          );
      }

      guildCommands[guild.id] = [];
    }),
  );

  const existingGlobalCommands = await client.application.commands.fetch();

  const newGlobalCommands = guildCommands[globalCommandKey] ?? [];
  const globalCommandsNeedUpdate = !compareCommands(
    existingGlobalCommands,
    newGlobalCommands,
  );

  if (globalCommandsNeedUpdate) {
    await client.application.commands.set(newGlobalCommands);
    if (options.debug) console.log("Updated global commands");
  } else {
    if (options.debug) console.log("Global commands are already up-to-date");
  }

  guildCommands[globalCommandKey] = [];

  for (const guildId in guildCommands) {
    if (!Object.prototype.hasOwnProperty.call(guildCommands, guildId)) continue;

    const commands = guildCommands[guildId];
    if (!commands?.length) continue;

    await handleError(
      new ReferenceError(
        `Could not register commands in missing guild \`${guildId}\``,
      ),
      "ready",
    );
  }

  function compareCommands(
    existingCommands: Collection<
      string,
      ApplicationCommand<{ guild: GuildResolvable }>
    >,
    newCommands: string | any[],
  ) {
    if (existingCommands.size !== newCommands.length) return false;

    return [...existingCommands.values()].every((existingCommand, index) => {
      const newCommand = newCommands[index];
      return JSON.stringify(existingCommand) === JSON.stringify(newCommand);
    });
  }

  if (options.debug) console.log("Login Complete!");
}

export type LoginOptions = {
  clientOptions: ClientOptions;
  debug?: boolean;
  modulesDirectory: string;
  botToken?: string;
  commandErrorMessage?: string;
  handleError?: typeof defaultErrorHandler;
} & (DefaultCommandAccess extends { inGuild: true }
  ? { defaultCommandAccess: false | Snowflake | Snowflake[] }
  : { defaultCommandAccess?: true });
export function defaultErrorHandler(
  error: any,
  event: string | RepliableInteraction,
): Awaitable<void> {
  console.error(
    `[${
      typeof event == "string"
        ? event
        : event.isCommand()
          ? `/${event.command?.name}`
          : `${event.constructor.name}: ${event.customId}`
    }]`,
    error,
  );
}
