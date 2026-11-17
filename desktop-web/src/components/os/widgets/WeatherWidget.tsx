import { useEffect, useState } from 'react';
import { CloudSun } from '@phosphor-icons/react';
import { AppID } from '../../../apps/registry';
import { useOS } from '../../../context/OSContext';
import type { PlacedItem } from '../../../registry/widgets/layout';
import { fetchWeatherWithFallback, type WeatherData } from '../../../utils/realtimeWorldCore';
import type { WidgetRenderContext } from '../desktopWidgetRegistry';

type WeatherResult = { city: string; data: WeatherData | null };

export function WeatherWidget({ item, ctx }: { item: PlacedItem; ctx: WidgetRenderContext }) {
    const { realtimeConfig } = useOS();
    const city = realtimeConfig.weatherEnabled ? realtimeConfig.weatherCity.trim() : '';
    const apiKey = realtimeConfig.weatherApiKey?.trim() || '';
    const [result, setResult] = useState<WeatherResult | null>(null);

    useEffect(() => {
        if (!city) return;

        let cancelled = false;
        void fetchWeatherWithFallback(city, apiKey).then(data => {
            if (!cancelled) setResult({ city, data });
        }).catch(error => {
            console.warn('[WeatherWidget] 获取天气失败', error);
            if (!cancelled) setResult({ city, data: null });
        });

        return () => { cancelled = true; };
    }, [city, apiKey]);

    const current = result?.city === city ? result : null;
    const weather = current?.data;
    const status = city ? (current ? '天气暂不可用' : '正在获取天气…') : '在设置中开启天气并填写城市';
    const opacity = (item.config?.opacity ?? ctx.widgetOpacity?.weather ?? 100) / 100;

    return (
        <button type="button" disabled={ctx.editing} onClick={() => ctx.openApp(AppID.Settings)}
            className="flex h-full w-full flex-col justify-center gap-1 rounded-2xl bg-white/15 p-3 text-left"
            style={{ color: ctx.contentColor, opacity }}>
            <span className="flex items-center gap-1 text-sm"><CloudSun size={18} />{weather?.city ?? (city || '天气')}</span>
            {weather ? <><strong className="text-2xl">{weather.temp}°</strong><span className="text-xs">{weather.description}</span></>
                : <span className="text-xs">{status}</span>}
        </button>
    );
}
