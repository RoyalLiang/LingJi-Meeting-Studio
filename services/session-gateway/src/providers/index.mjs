import { createDoubaoAstProvider } from "./doubao-ast-provider.mjs";
import { createDeepgramAsrProvider } from "./deepgram-asr-provider.mjs";
import { createMockAsrProvider } from "./mock-asr-provider.mjs";

function unsupportedAsrProviderError(providerName) {
  const error = new Error(`Unsupported ASR provider "${providerName}".`);
  error.statusCode = 500;
  error.errorCode = "unsupported_asr_provider";
  return error;
}

function fallbackProviderError(providerName, detail) {
  const error = new Error(detail);
  error.statusCode = 500;
  error.errorCode = `asr_provider_${providerName}_failed`;
  return error;
}

function providerNameFromOptions(options = {}) {
  return options.providerName
    ?? options.asrProviderName
    ?? process.env.ASR_PROVIDER
    ?? "mock";
}

function fallbackProviderNameFromOptions(options = {}) {
  return options.fallbackProviderName
    ?? options.asrFallbackProvider
    ?? process.env.ASR_FALLBACK_PROVIDER
    ?? null;
}

async function createProviderByName(providerName, options = {}) {
  switch (providerName) {
    case "mock":
      return createMockAsrProvider();
    case "deepgram":
      return createDeepgramAsrProvider(options);
    case "doubao-ast":
      return createDoubaoAstProvider(options);
    default:
      throw unsupportedAsrProviderError(providerName);
  }
}

function providerSessionState(provider, sessionId) {
  if (typeof provider.createSessionState === "function") {
    return provider.createSessionState({
      sessionId
    });
  }

  return {};
}

function fallbackEnabled(state) {
  return Boolean(state.fallbackProvider);
}

function currentProviderEntry(state) {
  if (state.activeProviderSlot === "fallback" || !state.primaryProvider) {
    return {
      provider: state.fallbackProvider,
      sessionState: state.fallbackSessionState
    };
  }

  return {
    provider: state.primaryProvider,
    sessionState: state.primarySessionState
  };
}

function activateFallback(state, error) {
  if (!fallbackEnabled(state)) {
    throw error;
  }

  state.activeProviderSlot = "fallback";
  state.fallbackReason = error instanceof Error ? error.message : String(error);
  return fallbackProviderError(
    state.primaryProviderName ?? "primary",
    state.fallbackReason
  );
}

function createResilientProvider(options) {
  const primaryProvider = options.primaryProvider ?? null;
  const fallbackProvider = options.fallbackProvider ?? null;
  const startupError = options.startupError ?? null;

  return {
    name: options.primaryProviderName,
    providerId: primaryProvider?.providerId ?? fallbackProvider?.providerId ?? options.primaryProviderName,
    activeProviderName: primaryProvider ? primaryProvider.name : fallbackProvider?.name ?? options.primaryProviderName,
    fallbackProviderName: fallbackProvider?.name ?? null,
    startupError: startupError?.message ?? null,
    createSessionState({ sessionId }) {
      return {
        primaryProviderName: options.primaryProviderName,
        primaryProvider,
        primarySessionState: primaryProvider ? providerSessionState(primaryProvider, sessionId) : null,
        fallbackProvider,
        fallbackSessionState: fallbackProvider ? providerSessionState(fallbackProvider, sessionId) : null,
        activeProviderSlot: primaryProvider ? "primary" : "fallback",
        fallbackReason: startupError?.message ?? null
      };
    },
    async disposeSessionState(sessionState) {
      if (primaryProvider) {
        await disposeAsrProviderSessionState(primaryProvider, sessionState?.primarySessionState);
      }

      if (fallbackProvider) {
        await disposeAsrProviderSessionState(fallbackProvider, sessionState?.fallbackSessionState);
      }
    },
    async *transcribeText(input) {
      const sessionState = input.sessionState;
      const run = async function* (provider, providerState) {
        yield* provider.transcribeText({
          ...input,
          sessionState: providerState
        });
      };

      try {
        const { provider, sessionState: providerState } = currentProviderEntry(sessionState);
        yield* run(provider, providerState);
      } catch (error) {
        const wrapped = activateFallback(sessionState, error);
        console.warn(`[session-gateway] primary ASR provider failed, falling back: ${wrapped.message}`);
        const { provider, sessionState: providerState } = currentProviderEntry(sessionState);
        yield* run(provider, providerState);
      }
    },
    async *transcribeAudioChunk(input) {
      const sessionState = input.sessionState;
      const run = async function* (provider, providerState) {
        yield* provider.transcribeAudioChunk({
          ...input,
          sessionState: providerState
        });
      };

      try {
        const { provider, sessionState: providerState } = currentProviderEntry(sessionState);
        yield* run(provider, providerState);
      } catch (error) {
        const wrapped = activateFallback(sessionState, error);
        console.warn(`[session-gateway] primary ASR provider failed, falling back: ${wrapped.message}`);
        const { provider, sessionState: providerState } = currentProviderEntry(sessionState);
        yield* run(provider, providerState);
      }
    }
  };
}

export async function createAsrProvider(options = {}) {
  const providerName = providerNameFromOptions(options);
  const fallbackProviderName = fallbackProviderNameFromOptions(options);

  if (!fallbackProviderName || fallbackProviderName === providerName) {
    return createProviderByName(providerName, options);
  }

  let primaryProvider = null;
  let startupError = null;

  try {
    primaryProvider = await createProviderByName(providerName, options);
  } catch (error) {
    startupError = error;
  }

  if (!primaryProvider) {
    console.warn(`[session-gateway] unable to initialize primary ASR provider "${providerName}", using fallback "${fallbackProviderName}"`);
  }

  const fallbackProvider = await createProviderByName(fallbackProviderName, options);

  if (!primaryProvider && !fallbackProvider) {
    throw startupError ?? unsupportedAsrProviderError(providerName);
  }

  return createResilientProvider({
    primaryProviderName: providerName,
    primaryProvider,
    fallbackProvider,
    startupError
  });
}

export function createAsrProviderSessionState(provider, sessionId) {
  if (typeof provider.createSessionState === "function") {
    return provider.createSessionState({
      sessionId
    });
  }

  return {};
}

export async function disposeAsrProviderSessionState(provider, sessionState) {
  if (typeof provider.disposeSessionState === "function") {
    await provider.disposeSessionState(sessionState);
  }
}
