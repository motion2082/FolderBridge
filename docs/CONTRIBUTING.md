# Contributing to FolderBridge

Thank you for your interest in contributing to FolderBridge! This document provides guidelines and instructions for contributing.

## 🎯 Ways to Contribute

- 🐛 Report bugs
- 💡 Suggest new features
- 📝 Improve documentation
- 🔧 Submit bug fixes
- ✨ Implement new features
- 🧪 Write tests
- 📖 Create tutorials or examples

## 🚀 Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Obsidian_FolderBridge.git
   cd Obsidian_FolderBridge
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## 📋 Development Process

### 1. Make Your Changes

- Follow the existing code style
- Keep changes focused and atomic
- Write clear, descriptive commit messages
- Test your changes thoroughly

### 2. Code Standards

#### TypeScript
- Use strict type checking (already configured)
- Define interfaces for all data structures
- Avoid `any` types when possible
- Use async/await for asynchronous code

#### Code Style
- Use tabs for indentation (4 spaces)
- Follow ESLint rules
- Add comments for complex logic
- Keep functions small and focused

#### Naming Conventions
- Classes: `PascalCase`
- Functions/methods: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Private members: prefix with underscore `_privateMethod`

### 3. Testing

Before submitting:

```bash
# Check reviewer-facing UI copy style
npm run check:ui-text

# Full local validation
npm run validate

# Optional: install the repo's pre-commit hook once per clone
npm run hooks:install

# Test in Obsidian
# Link plugin to vault and test manually
```

The pre-commit hook is optional but recommended for this repository. It keeps UI copy regressions out of commits by running the UI copy style checker before the commit is created.

### 4. Commit Guidelines

Use conventional commit messages:

```
feat: add support for nested mount points
fix: resolve path separator issue on Windows
docs: update installation instructions
style: format code according to ESLint rules
refactor: simplify path resolution logic
test: add tests for mount point validation
chore: update dependencies
```

### 5. Submit a Pull Request

1. **Push your branch** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open a Pull Request** on GitHub

3. **Fill out the PR template** with:
   - Clear description of changes
   - Related issue numbers (if any)
   - Screenshots (for UI changes)
   - Testing performed

4. **Wait for review** and address feedback

## 🐛 Reporting Bugs

### Before Submitting

- Check existing issues for duplicates
- Test with the latest version
- Verify it's not a known limitation

### Bug Report Template

```markdown
**Description**
Clear description of the bug

**To Reproduce**
Steps to reproduce:
1. Go to '...'
2. Click on '...'
3. See error

**Expected Behavior**
What should happen

**Actual Behavior**
What actually happens

**Environment**
- OS: [e.g., macOS 14.0]
- Obsidian version: [e.g., 1.5.3]
- Plugin version: [e.g., 0.1.0]

**Additional Context**
Screenshots, error messages, etc.
```

## 💡 Suggesting Features

### Feature Request Template

```markdown
**Problem Statement**
What problem does this solve?

**Proposed Solution**
How should it work?

**Alternatives Considered**
What other approaches did you think about?

**Additional Context**
Mockups, examples, etc.
```

## 📝 Documentation

Good documentation helps everyone:

- Keep README.md up to date
- Document new features in DEVELOPMENT.md
- Add code comments for complex logic
- Update EXAMPLE_CONFIG.md if adding configuration options
- Include JSDoc comments for public APIs

## 🔍 Code Review Process

All submissions require review:

1. **Automated checks** must pass:
   - Build succeeds
   - Linting passes
   - TypeScript compiles

2. **Manual review** looks for:
   - Code quality and style
   - Test coverage
   - Documentation updates
   - Breaking changes

3. **Feedback** may request:
   - Changes to implementation
   - Additional tests
   - Documentation improvements

## 🎨 Project Structure

```
Obsidian_FolderBridge/
├── .github/              # GitHub templates and workflows
├── .vscode/              # VS Code configuration
├── main.ts               # Main plugin code
├── manifest.json         # Plugin metadata
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript config
├── esbuild.config.mjs    # Build configuration
└── docs/                 # Additional documentation
```

## 🔐 Security

If you discover a security vulnerability:

1. **Do NOT** open a public issue
2. Email the maintainers privately
3. Include details and reproduction steps
4. Wait for confirmation before disclosure

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 🙏 Recognition

Contributors will be:
- Listed in the CONTRIBUTORS file
- Mentioned in release notes
- Credited in the documentation

## 💬 Questions?

- Open a discussion on GitHub
- Check existing documentation
- Ask in the Obsidian Discord

## 🎉 Thank You!

Your contributions make FolderBridge better for everyone!
