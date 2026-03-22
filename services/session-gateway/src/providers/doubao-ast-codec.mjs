import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import protobuf from "protobufjs";

function providerError(errorCode, detail) {
  const error = new Error(detail);
  error.statusCode = 500;
  error.errorCode = errorCode;
  return error;
}

const codecDir = path.dirname(fileURLToPath(import.meta.url));
const bundledProtoBaseDir = path.join(codecDir, "doubao-ast", "protos");
const bundledEntryProto = path.join(
  bundledProtoBaseDir,
  "products",
  "understanding",
  "ast",
  "ast_service.proto"
);

function requiredCodecMethods() {
  return [
    "encodeStartSession",
    "encodeUpdateConfig",
    "encodeTaskRequest",
    "encodeFinishSession",
    "decodeMessage"
  ];
}

function validateCodecImplementation(codec) {
  if (!codec || typeof codec !== "object") {
    throw providerError(
      "missing_doubao_ast_codec",
      "Doubao AST provider requires a protobuf codec implementation."
    );
  }

  for (const methodName of requiredCodecMethods()) {
    if (typeof codec[methodName] !== "function") {
      throw providerError(
        "invalid_doubao_ast_codec",
        `Doubao AST codec is missing required method "${methodName}".`
      );
    }
  }

  return codec;
}

async function loadCodecFromModule(moduleSpecifier) {
  let importedModule;

  try {
    const specifier = moduleSpecifier.match(/^[a-zA-Z]+:/)
      ? moduleSpecifier
      : pathToFileURL(path.resolve(moduleSpecifier)).href;
    importedModule = await import(specifier);
  } catch (error) {
    throw providerError(
      "doubao_ast_codec_load_failed",
      `Failed to load Doubao AST codec module "${moduleSpecifier}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const candidate = importedModule.createDoubaoAstCodec?.()
    ?? importedModule.doubaoAstCodec
    ?? importedModule.default;

  return validateCodecImplementation(candidate);
}

function createBundledRoot() {
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    if (target.startsWith("common/") || target.startsWith("products/")) {
      return path.join(bundledProtoBaseDir, target);
    }

    return protobuf.util.path.resolve(origin, target);
  };
  return root;
}

function eventCodeByName(root, name) {
  const eventEnum = root.lookupEnum("data.speech.event.Type");
  const value = eventEnum.values[name];

  if (typeof value !== "number") {
    throw providerError(
      "doubao_ast_unknown_event_type",
      `Unable to resolve Doubao AST event enum "${name}".`
    );
  }

  return value;
}

function createBundledCodec(root) {
  const translateRequest = root.lookupType("data.speech.ast.TranslateRequest");
  const translateResponse = root.lookupType("data.speech.ast.TranslateResponse");

  function encodeRequest(payload) {
    const message = translateRequest.fromObject(payload);
    return Buffer.from(translateRequest.encode(message).finish());
  }

  return {
    encodeStartSession(payload) {
      return encodeRequest({
        ...payload,
        event: eventCodeByName(root, "StartSession")
      });
    },
    encodeUpdateConfig(payload) {
      return encodeRequest({
        ...payload,
        event: eventCodeByName(root, "UpdateConfig")
      });
    },
    encodeTaskRequest(payload) {
      return encodeRequest({
        ...payload,
        event: eventCodeByName(root, "TaskRequest")
      });
    },
    encodeFinishSession(payload) {
      return encodeRequest({
        ...payload,
        event: eventCodeByName(root, "FinishSession")
      });
    },
    decodeMessage(frame) {
      const decoded = translateResponse.decode(frame);
      return translateResponse.toObject(decoded, {
        longs: Number,
        enums: Number,
        defaults: false,
        bytes: Buffer
      });
    }
  };
}

export async function createDoubaoAstCodec() {
  const root = createBundledRoot();

  try {
    await root.load(bundledEntryProto);
  } catch (error) {
    throw providerError(
      "doubao_ast_codec_load_failed",
      `Failed to load bundled Doubao AST proto files: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return createBundledCodec(root);
}

export async function resolveDoubaoAstCodec(options = {}) {
  if (options.doubaoAstCodec) {
    return validateCodecImplementation(options.doubaoAstCodec);
  }

  const moduleSpecifier = options.doubaoAstCodecModule
    ?? process.env.DOUBAO_AST_CODEC_MODULE
    ?? null;

  if (moduleSpecifier) {
    return loadCodecFromModule(moduleSpecifier);
  }

  return createDoubaoAstCodec();
}
