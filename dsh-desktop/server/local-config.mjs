import {homedir} from 'node:os';
import {join} from 'node:path';

export const configPath=process.env.DSH_DESKTOP_CONFIG??join(homedir(),'.dsh-desktop','config.json');
