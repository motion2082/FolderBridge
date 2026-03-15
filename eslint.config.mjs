import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default tseslint.config(
    ...tseslint.configs.recommended,
    ...obsidianmd.configs.recommended, {
    languageOptions: {
        sourceType: 'module',
        globals: {
            require: 'readonly',
            process: 'readonly',
            __dirname: 'readonly',
            __filename: 'readonly',
            module: 'readonly',
            exports: 'writable',
            Buffer: 'readonly',
            console: 'readonly',
            setTimeout: 'readonly',
            setInterval: 'readonly',
            clearTimeout: 'readonly',
            clearInterval: 'readonly',
            URL: 'readonly',
            Promise: 'readonly',
            describe: 'readonly',
            it: 'readonly',
            expect: 'readonly',
            beforeEach: 'readonly',
            afterEach: 'readonly',
            vi: 'readonly',
        },
    },
    rules: {
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
        '@typescript-eslint/ban-ts-comment': 'off',
        'no-prototype-builtins': 'off',
        '@typescript-eslint/no-empty-function': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-this-alias': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-var-requires': 'off',
        // Configure sentence-case with project-specific brands and acronyms.
        // brands/acronyms replace the defaults so the full default lists must be
        // included alongside our additions.
        'obsidianmd/ui/sentence-case': ['warn', {
            brands: [
                // Default brands (preserved so we do not lose built-in recognition)
                'iOS', 'iPadOS', 'macOS', 'Windows', 'Android', 'Linux',
                'Obsidian', 'Obsidian Sync', 'Obsidian Publish',
                'Google Drive', 'Dropbox', 'OneDrive', 'iCloud Drive',
                'YouTube', 'Slack', 'Discord', 'Telegram', 'WhatsApp', 'Twitter', 'X',
                'Readwise', 'Zotero', 'Excalidraw', 'Mermaid',
                'Markdown', 'LaTeX', 'JavaScript', 'TypeScript', 'Node.js',
                'npm', 'pnpm', 'Yarn', 'Git', 'GitHub', 'GitLab',
                'Notion', 'Evernote', 'Roam Research', 'Logseq', 'Anki',
                'Reddit', 'VS Code', 'Visual Studio Code', 'IntelliJ IDEA', 'WebStorm', 'PyCharm',
                // Project-specific brands
                'Folder Bridge',
                'WebDAV', // mixed-case acronym; must be a brand to preserve casing
                'Amazon S3',
                'Backblaze B2',
                'Cloudflare R2',
                'MinIO',
                'Nextcloud',
                'Synology',
                'Syncthing',
                'QuickAdd',
                'Quick Switcher',
            ],
            acronyms: [
                // Default acronyms (preserved so we do not lose built-in recognition)
                'API', 'HTTP', 'HTTPS', 'URL', 'DNS', 'TCP', 'IP',
                'SSH', 'TLS', 'SSL', 'FTP', 'SFTP', 'SMTP',
                'JSON', 'XML', 'HTML', 'CSS', 'PDF', 'CSV', 'YAML', 'SQL',
                'PNG', 'JPG', 'JPEG', 'GIF', 'SVG',
                '2FA', 'MFA', 'OAuth', 'JWT', 'LDAP', 'SAML',
                'SDK', 'IDE', 'CLI', 'GUI', 'CRUD', 'REST', 'SOAP',
                'CPU', 'GPU', 'RAM', 'SSD', 'USB',
                'UI', 'OK', 'RSS', 'S3',
                'ID', 'UUID', 'GUID', 'SHA', 'MD5', 'ASCII',
                'UTF-8', 'UTF-16', 'DOM', 'CDN', 'FAQ', 'AI', 'ML',
                // Project-specific acronyms
                'TOC', // table of contents
                'NAS', // network-attached storage
                'WSL', // Windows Subsystem for Linux
                'IAM', // AWS Identity and Access Management
                'DSM', // Synology DiskStation Manager
                'QNAP', // QNAP brand (also used acronym-style in labels)
                'OS', // operating system
                'MB', // megabytes
                'URI', // uniform resource identifier
                'AWS', // Amazon Web Services
                'B2', // Backblaze B2 storage class
            ],
        }],
    },
},
);
