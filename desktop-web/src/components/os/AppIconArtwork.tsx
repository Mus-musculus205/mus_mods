import type { DesktopAppDefinition } from '../../apps/registry';
import type { AppConfig } from '../../types';
import { Icons } from '../../constants';
import { useOS } from '../../context/OSContext';
import { useBlobRefUrl } from '../../utils/blobRef';
import { getAcnhIcon } from './acnhIcons';
import { getNookAppTileColor } from './nookColors';

export function useAppIconArtwork(app: DesktopAppDefinition | AppConfig | undefined, isNook: boolean) {
  const { customIcons } = useOS();
  const customIconUrl = useBlobRefUrl(app && !isNook ? customIcons[app.id] : undefined);

  const icon = app && ('iconKey' in app ? app.iconKey : app.icon);

  return {
    customIconUrl,
    DefaultIcon: (icon && Icons[icon]) || Icons.Settings,
    nookTile: app && isNook ? {
      color: getNookAppTileColor(app.color),
      glyph: getAcnhIcon(app.id),
    } : null,
  };
}
