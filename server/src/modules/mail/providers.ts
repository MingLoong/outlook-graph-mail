/**
 * 第三方邮箱提供商配置
 * 参考 outlookEmailPlus 项目实现
 */

export interface MailProvider {
  label: string;
  imapHost: string;
  imapPort: number;
  accountType: 'outlook' | 'imap';
  note?: string;
  authType?: 'oauth2' | 'password';
}

export const MAIL_PROVIDERS: Record<string, MailProvider> = {
  outlook: {
    label: 'Outlook/Microsoft',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    accountType: 'outlook',
    note: '使用 OAuth2 认证（client_id + refresh_token）',
    authType: 'oauth2',
  },
  gmail: {
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    accountType: 'imap',
    note: '需开启 IMAP，并使用应用专用密码（非登录密码）',
    authType: 'password',
  },
  qq: {
    label: 'QQ邮箱',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    accountType: 'imap',
    note: '需开启 IMAP 服务，使用授权码（非 QQ 密码）',
    authType: 'password',
  },
  '163': {
    label: '163邮箱',
    imapHost: 'imap.163.com',
    imapPort: 993,
    accountType: 'imap',
    note: '需开启 IMAP 服务，使用授权码',
    authType: 'password',
  },
  '126': {
    label: '126邮箱',
    imapHost: 'imap.126.com',
    imapPort: 993,
    accountType: 'imap',
    note: '需开启 IMAP 服务，使用授权码',
    authType: 'password',
  },
  yahoo: {
    label: 'Yahoo邮箱',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    accountType: 'imap',
    note: '需在账户安全设置中生成应用密码',
    authType: 'password',
  },
  aliyun: {
    label: '阿里邮箱',
    imapHost: 'imap.aliyun.com',
    imapPort: 993,
    accountType: 'imap',
    note: '使用阿里邮箱登录密码或授权码',
    authType: 'password',
  },
  custom: {
    label: '自定义 IMAP',
    imapHost: '',
    imapPort: 993,
    accountType: 'imap',
    note: '手动填写 IMAP 服务器地址和端口',
    authType: 'password',
  },
};

// 域名 -> provider 反向映射（用于自动识别）
export const DOMAIN_PROVIDER_MAP: Record<string, string> = {
  // Gmail
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  // QQ
  'qq.com': 'qq',
  'foxmail.com': 'qq',
  // 163
  '163.com': '163',
  // 126
  '126.com': '126',
  // Yahoo
  'yahoo.com': 'yahoo',
  'yahoo.co.jp': 'yahoo',
  'yahoo.co.uk': 'yahoo',
  'yahoo.com.cn': 'yahoo',
  // 阿里
  'aliyun.com': 'aliyun',
  'alimail.com': 'aliyun',
  // Microsoft
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'live.cn': 'outlook',
  'msn.com': 'outlook',
};

// provider -> 自动分组名称映射
export const PROVIDER_GROUP_NAME: Record<string, string> = {
  outlook: 'Outlook',
  gmail: 'Gmail',
  qq: 'QQ邮箱',
  '163': '163邮箱',
  '126': '126邮箱',
  yahoo: 'Yahoo',
  aliyun: '阿里邮箱',
  custom: '自定义IMAP',
};

// provider -> 文件夹映射
export const PROVIDER_FOLDER_MAP: Record<string, Record<string, string[]>> = {
  gmail: {
    inbox: ['INBOX'],
    junkemail: ['[Gmail]/Spam', '[Gmail]/垃圾邮件'],
    deleteditems: ['[Gmail]/Trash', '[Gmail]/已删除邮件'],
  },
  qq: {
    inbox: ['INBOX'],
    junkemail: ['Junk', '&V4NXPpCuTvY-'],
    deleteditems: ['Deleted Messages', '&XfJT0ZABkK5O9g-'],
  },
  '163': {
    inbox: ['INBOX'],
    junkemail: ['&V4NXPpCuTvY-'],
    deleteditems: ['&XfJT0ZABkK5O9g-'],
  },
  '126': {
    inbox: ['INBOX'],
    junkemail: ['Junk', '&V4NXPpCuTvY-'],
    deleteditems: ['Deleted Messages', '&XfJT0ZABkK5O9g-'],
  },
  yahoo: {
    inbox: ['INBOX'],
    junkemail: ['Bulk Mail', 'Spam'],
    deleteditems: ['Trash'],
  },
  aliyun: {
    inbox: ['INBOX'],
    junkemail: ['Junk', 'Spam'],
    deleteditems: ['Trash', 'Deleted Messages'],
  },
  _default: {
    inbox: ['INBOX'],
    junkemail: ['Junk', 'Junk Email', 'Spam', 'SPAM', 'Bulk Mail', '垃圾邮件'],
    deleteditems: ['Trash', 'Deleted', 'Deleted Messages', '已删除邮件'],
  },
};

export function inferProviderFromEmail(email: string): string | undefined {
  if (!email || !email.includes('@')) return undefined;
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return undefined;
  return DOMAIN_PROVIDER_MAP[domain];
}

export function getImapFolderCandidates(provider: string, folder: string): string[] {
  const providerKey = (provider || '').trim() || '_default';
  const folderKey = (folder || '').trim().toLowerCase() || 'inbox';
  const folderMap = PROVIDER_FOLDER_MAP[providerKey] || PROVIDER_FOLDER_MAP._default;
  return folderMap[folderKey] || PROVIDER_FOLDER_MAP._default[folderKey] || ['INBOX'];
}

export function getProviderList() {
  const order = ['auto', 'outlook', 'gmail', 'qq', '163', '126', 'yahoo', 'aliyun', 'custom'];
  const result: Array<{
    key: string;
    label: string;
    accountType: 'outlook' | 'imap' | 'mixed';
    authType?: 'oauth2' | 'password';
    note?: string;
    imapHost?: string;
    imapPort?: number;
  }> = [
    {
      key: 'auto',
      label: '🔍 智能识别（混合导入）',
      accountType: 'mixed',
      note: '自动识别每行的账号类型，支持混合文件',
    },
  ];
  for (const key of order) {
    if (key === 'auto') continue;
    const p = MAIL_PROVIDERS[key];
    if (!p) continue;
    result.push({
      key,
      label: p.label,
      accountType: p.accountType,
      authType: p.authType,
      note: p.note,
      imapHost: p.imapHost,
      imapPort: p.imapPort,
    });
  }
  return result;
}

export function getProviderConfig(provider: string): MailProvider | undefined {
  const key = (provider || '').trim().toLowerCase();
  return MAIL_PROVIDERS[key];
}
