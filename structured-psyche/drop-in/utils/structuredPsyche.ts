export interface StructuredPsyche {
    reply: string;
    psyche: string;
}

export const shouldUseStructuredPsyche = (input: {
    enabled: boolean;
}): boolean => input.enabled;

export const buildStructuredPsycheResponseFormat = () => ({
    type: 'json_schema' as const,
    json_schema: {
        name: 'roleplay_response',
        schema: {
            type: 'object' as const,
            properties: {
                reply: {
                    type: 'string' as const,
                    description: 'The character reply that is spoken aloud to the user.',
                },
                psyche: {
                    type: 'string' as const,
                    description: 'The character first-person immediate inner activity that remains unspoken.',
                },
            },
            required: ['reply', 'psyche'],
            additionalProperties: false,
        },
    },
});

export function parseStructuredPsyche(content: unknown): StructuredPsyche {
    if (typeof content !== 'string') {
        throw new Error('Structured psyche protocol error: message.content must be a string');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error('Structured psyche protocol error: message.content is not valid JSON');
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('Structured psyche protocol error: top-level JSON must be an object');
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record.reply !== 'string' || !record.reply.trim()) {
        throw new Error('Structured psyche protocol error: reply must be a non-empty string');
    }
    if (typeof record.psyche !== 'string' || !record.psyche.trim()) {
        throw new Error('Structured psyche protocol error: psyche must be a non-empty string');
    }

    return {
        reply: record.reply.trim(),
        psyche: record.psyche.trim(),
    };
}
