import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Minus } from '@phosphor-icons/react';
import { Anniversary, CharacterProfile, Task } from '../../../types';

interface AnniversaryWidgetProps {
  contentColor: string;
  openApp: (id: string) => void;
  anniversaries?: Anniversary[];
  tasks?: Task[];
  characters?: CharacterProfile[];
  acnh?: boolean;
  paper?: boolean;
  editing?: boolean;
  onDelete?: () => void;
  opacity?: number;
}

export interface UpcomingWidgetEvent {
  id: string;
  title: string;
  date: string;
  charId?: string;
  isTodo?: boolean;
}

export const getTaskDate = (task: Task): string => {
  if (task.deadline) return task.deadline;
  const d = new Date(task.createdAt);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export function buildUpcomingWidgetEvents(
  anniversaries: Anniversary[],
  tasks: Task[],
  todayStr: string,
): UpcomingWidgetEvent[] {
  const list: UpcomingWidgetEvent[] = [];

  for (const a of anniversaries) {
    if (a.date >= todayStr) {
      list.push({
        id: a.id,
        title: a.title,
        date: a.date,
        charId: a.charId,
      });
    }
  }

  for (const t of tasks) {
    if (t.isCompleted) continue;
    let date: string;
    if (t.deadline) {
      date = t.deadline;
    } else {
      const createdDate = getTaskDate(t);
      date = createdDate < todayStr ? todayStr : createdDate;
    }

    list.push({
      id: `todo-${t.id}`,
      title: t.title,
      date,
      charId: t.supervisorId,
      isTodo: true,
    });
  }

  return list.sort((a, b) => a.date.localeCompare(b.date));
}

export const AnniversaryWidget: React.FC<AnniversaryWidgetProps> = ({
  contentColor,
  openApp,
  anniversaries = [],
  tasks = [],
  characters = [],
  acnh = false,
  paper = false,
  editing = false,
  onDelete,
  opacity = 100,
}) => {
  const scale = Math.max(0, Math.min(100, opacity ?? 100)) / 100;
  const acCard: React.CSSProperties | undefined = acnh
    ? {
        background: `rgba(247,243,223, ${scale})`,
        border: `2px solid rgba(232,226,214, ${scale})`,
        boxShadow: `0 6px 18px rgba(61,52,40, ${0.12 * scale})`,
        color: '#725d42',
      }
    : undefined;
  const paperCard: React.CSSProperties | undefined = paper
    ? {
        background: `rgba(224,221,215, ${0.36 * scale})`,
        border: `1px solid rgba(91,72,51, ${0.07 * scale})`,
        boxShadow: `0 5px 16px rgba(91,72,51, ${0.055 * scale})`,
        color: contentColor,
      }
    : undefined;
  const defaultCard: React.CSSProperties | undefined = !acnh && !paper
    ? {
        background: `rgba(255,255,255, ${0.35 * scale})`,
        backdropFilter: scale > 0.05 ? `blur(${20 * scale}px)` : 'none',
        WebkitBackdropFilter: scale > 0.05 ? `blur(${20 * scale}px)` : 'none',
        border: `1px solid rgba(255,255,255, ${0.35 * scale})`,
        boxShadow: `0 8px 32px rgba(0,0,0, ${0.18 * scale}), inset 0 1px 0 rgba(255,255,255, ${0.08 * scale})`,
        color: contentColor,
      }
    : undefined;
  const acDot = acnh ? '#6fba2c' : undefined;
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const todayStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const upcomingEvents = useMemo(
    () => buildUpcomingWidgetEvents(anniversaries, tasks, todayStr),
    [anniversaries, tasks, todayStr]
  );
  const EVENTS_PER_PAGE = 4;
  const eventPageCount = Math.max(1, Math.ceil(upcomingEvents.length / EVENTS_PER_PAGE));
  const [eventPage, setEventPage] = useState(0);

  useEffect(() => {
    if (eventPage > eventPageCount - 1) setEventPage(Math.max(0, eventPageCount - 1));
  }, [eventPageCount, eventPage]);

  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [eventPage]);

  const pagedEvents = upcomingEvents.slice(
    eventPage * EVENTS_PER_PAGE,
    eventPage * EVENTS_PER_PAGE + EVENTS_PER_PAGE
  );

  return (
    <div className="relative group w-full h-full select-none">
      {/* 编辑模式下的红色删除按钮 */}
      {editing && onDelete && (
        <button
          data-launcher-action="remove"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute -top-2.5 -right-2.5 w-6 h-6 rounded-full bg-red-500 text-white font-black text-sm flex items-center justify-center shadow-lg active:scale-90 z-30 transition-transform hover:bg-red-600"
          title="删除纪念日组件"
        >
          <Minus size={14} weight="bold" />
        </button>
      )}

      <div
        className="w-full h-full rounded-3xl p-5 flex flex-col overflow-hidden"
        style={paperCard || acCard || defaultCard}
      >
        <div className="flex items-center justify-between mb-3.5 shrink-0">
          <h3
            className="text-xs font-bold opacity-60 uppercase tracking-widest flex items-center gap-2"
            style={{ color: contentColor }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: acDot || (paper ? '#a66f52' : '#c084fc') }}
            />{' '}
            Upcoming Events
          </h3>
          {eventPageCount > 1 && (
            <div className="flex items-center gap-2 shrink-0" style={{ color: contentColor }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEventPage((p) => Math.max(0, p - 1));
                }}
                disabled={eventPage === 0}
                className={`w-6 h-6 rounded-full flex items-center justify-center disabled:opacity-25 transition-colors active:scale-90 ${
                  paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/15 hover:bg-white/30'
                }`}
                aria-label="Previous events"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2.5}
                  stroke="currentColor"
                  className="w-3 h-3"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
              </button>
              <span className="text-[10px] font-mono opacity-60 tabular-nums">
                {eventPage + 1}/{eventPageCount}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEventPage((p) => Math.min(eventPageCount - 1, p + 1));
                }}
                disabled={eventPage >= eventPageCount - 1}
                className={`w-6 h-6 rounded-full flex items-center justify-center disabled:opacity-25 transition-colors active:scale-90 ${
                  paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/15 hover:bg-white/30'
                }`}
                aria-label="Next events"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2.5}
                  stroke="currentColor"
                  className="w-3 h-3"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-0.5 desktop-scrollbar overscroll-contain"
        >
          {upcomingEvents.length > 0 ? (
            pagedEvents.map((anni: any) => (
              <div
                key={anni.id}
                onClick={() => { if (!editing) openApp('schedule'); }}
                className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-transform active:scale-[0.98] ${
                  acnh
                    ? 'bg-[#efe7d4] border border-[#e0d6c0]'
                    : paper
                    ? 'bg-[#f3ecdf]/70 border border-[#5b4833]/10'
                    : 'bg-white/5 border border-white/10'
                }`}
              >
                <div
                  className={`w-10 h-10 shrink-0 rounded-lg flex flex-col items-center justify-center ${
                    acnh
                      ? 'bg-[#82D5BB] text-white border border-[#6cc0a6]'
                      : paper
                      ? 'bg-[#a66f52]/12 text-[#8c5d46] border border-[#a66f52]/15'
                      : 'bg-purple-500/20 text-purple-200 border border-purple-500/30'
                  }`}
                >
                  <span className="text-[9px] opacity-70">{anni.date.split('-')[1]}</span>
                  <span className="text-sm font-bold leading-none">{anni.date.split('-')[2]}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold truncate" style={{ color: contentColor }}>
                    {anni.title}
                  </div>
                  <div className="text-[10px] opacity-50 truncate" style={{ color: contentColor }}>
                    {characters.find((c: any) => c.id === anni.charId)?.name || (anni.isTodo ? '待办' : 'Unknown')}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div
              onClick={() => { if (!editing) openApp('schedule'); }}
              className="text-center opacity-30 text-xs py-8 cursor-pointer hover:opacity-50 transition"
              style={{ color: contentColor }}
            >
              No upcoming events
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AnniversaryWidget;
