const { readString } = require("../_shared/translator-utils");

function reasoningVariants(model) {
  if (Object.hasOwn(model, "variants")) {
    if (!model.variants || typeof model.variants !== "object" || Array.isArray(model.variants)) return [];
    return Object.entries(model.variants).flatMap(([id, config]) => {
      if (!id || !config || typeof config !== "object" || Array.isArray(config)) return [];
      const effort = readString(config.reasoningEffort) || readString(config.reasoning_effort)
        || readString(config.effort) || readString(config.thinkingConfig?.thinkingLevel)
        || readString(config.thinking_config?.thinking_level) || readString(config.reasoning?.effort)
        || readString(config.reasoningConfig?.maxReasoningEffort);
      const reasoning = ["thinking", "thinkingConfig", "thinking_config", "reasoning", "reasoningConfig", "reasoning_config"]
        .some((key) => Object.hasOwn(config, key));
      return effort || reasoning || !Object.keys(config).length ? [{ id, effort }] : [];
    });
  }
  const options = model.reasoning_options ?? model.reasoningOptions
    ?? model.options?.reasoning_options ?? model.options?.reasoningOptions;
  const ids = new Set((Array.isArray(options) ? options : []).flatMap((option) =>
    option?.type === "effort" && Array.isArray(option.values)
      ? option.values.map((value) => value === null ? "none" : readString(value)).filter(Boolean) : []));
  return [...ids].map((id) => ({ id, effort: id }));
}

function normalizeModelCatalog(catalog) {
  const connected = Array.isArray(catalog?.connected) ? new Set(catalog.connected) : null;
  return (Array.isArray(catalog?.all) ? catalog.all : []).flatMap((provider) => {
    if (!provider?.id || (connected && !connected.has(provider.id))) return [];
    return Object.entries(provider.models || {}).map(([modelID, model]) => {
      const variants = reasoningVariants(model);
      const configured = model.options?.reasoningEffort ?? model.options?.reasoning_effort ?? model.options?.effort;
      const preferred = variants.find((variant) => variant.id === configured || variant.effort === configured);
      return {
        id: `${provider.id}/${modelID}`, model: `${provider.id}/${modelID}`,
        displayName: model.name || modelID, description: provider.name || provider.id,
        isDefault: catalog.default?.[provider.id] === modelID,
        serviceTiers: [], supportsFastMode: false,
        supportedReasoningEfforts: variants.map(({ id, effort }) => ({
          reasoningEffort: id, description: effort && effort !== id ? `${id} (${effort})` : id,
        })),
        defaultReasoningEffort: preferred?.id || null,
      };
    });
  });
}

module.exports = { normalizeModelCatalog };
