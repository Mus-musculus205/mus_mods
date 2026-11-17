import { useEffect, useMemo, useState } from 'react';
import { AppID } from '../../../apps/registry';
import { useOS } from '../../../context/OSContext';
import { useLocalDateKey } from '../../../hooks/useLocalDateKey';
import type { Anniversary, CharacterProfile, DailySchedule, Task } from '../../../types';
import { DB } from '../../../utils/db';
import { chatPreviewText, isChatPreviewMessage } from '../../../utils/chatMessageVisibility';
import { getDailyScheduleForChar } from '../../../utils/dailySchedule';
import { resolveCharTimeZone } from '../../../utils/timezone';

export function useLauncherWidgetData() {
  const { characters, activeCharacterId, lastMsgTimestamp, isDataLoaded, activeApp } = useOS();
  const [widgetChar, setWidgetChar] = useState<CharacterProfile | null>(null);
  const [lastMessage, setLastMessage] = useState('');
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scheduleData, setScheduleData] = useState<DailySchedule | null>(null);
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null);

  useEffect(() => {
    if (!isDataLoaded || activeApp !== AppID.Launcher) return;

    const character = characters.find(current => current.id === activeCharacterId) ?? characters[0];
    setWidgetChar(character ?? null);
    if (!character) {
      setLastMessage('No Character Connected');
      setAnniversaries([]);
      setTasks([]);
      return;
    }

    let cancelled = false;
    void Promise.all([
      DB.getRecentMessagesWithCount(character.id, 1, isChatPreviewMessage),
      DB.getAllAnniversaries(),
      DB.getAllTasks(),
    ]).then(([recent, nextAnniversaries, nextTasks]) => {
      if (cancelled) return;
      const last = recent.messages.at(-1);
      setLastMessage(last ? chatPreviewText(last) : character.description || 'System Ready.');
      setAnniversaries(nextAnniversaries);
      setTasks(nextTasks);
    }).catch(error => console.error('[Launcher] 读取小组件数据失败', error));

    return () => { cancelled = true; };
  }, [activeCharacterId, lastMsgTimestamp, isDataLoaded, characters, activeApp]);

  const scheduleChar = useMemo(
    () => characters.find(character => character.id === (scheduleCharId ?? activeCharacterId)) ?? characters[0] ?? null,
    [characters, scheduleCharId, activeCharacterId],
  );
  const scheduleDateKey = useLocalDateKey(resolveCharTimeZone(scheduleChar));
  useEffect(() => {
    if (!isDataLoaded || !scheduleChar) {
      setScheduleData(null);
      return;
    }

    let cancelled = false;
    void getDailyScheduleForChar(scheduleChar).then(schedule => {
      if (!cancelled) setScheduleData(schedule);
    }).catch(error => console.error('[Launcher] 读取桌面日程失败', error));
    return () => { cancelled = true; };
  }, [scheduleChar, isDataLoaded, scheduleDateKey]);

  return { widgetChar, lastMessage, anniversaries, tasks, scheduleData, scheduleChar, setScheduleCharId };
}
