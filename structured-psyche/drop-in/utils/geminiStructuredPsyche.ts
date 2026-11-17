// Backward-compatible bridge for the former provider-specific module name.
// @deprecated Import the generic API from './structuredPsyche'.
export {
    buildStructuredPsycheResponseFormat,
    buildStructuredPsycheResponseFormat as buildGeminiStructuredPsycheResponseFormat,
    parseStructuredPsyche,
    parseStructuredPsyche as parseGeminiStructuredPsyche,
    shouldUseStructuredPsyche,
    shouldUseStructuredPsyche as shouldUseGeminiStructuredPsyche,
} from './structuredPsyche';
export type {
    StructuredPsyche,
    StructuredPsyche as GeminiStructuredPsyche,
} from './structuredPsyche';
