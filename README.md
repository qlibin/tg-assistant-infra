# AWS infrastructure for personal assistant Telegram Bot

## 🤖 Working with Junie Agent

### Configuration

Junie Agent is configured with project-specific guidelines in `.junie/guidelines.md`. These include:

- TypeScript strict mode requirements
- Testing coverage standards
- Security best practices
- Code style conventions
- Anti-hallucination measures

### Best Practices

1. **Clear Instructions**: Provide specific, actionable requirements
2. **Context Awareness**: Ensure Junie understands existing code patterns
3. **Incremental Development**: Break complex features into smaller tasks
4. **Quality Verification**: Always review generated code and tests
5. **Guidelines Adherence**: Junie follows project-specific rules automatically

## 📊 Code Quality Standards

### TypeScript Configuration

- Strict mode enabled with comprehensive type checking
- No `any` types allowed - use `unknown` or proper types
- Exact optional property types enforced
- Unused locals and parameters detected

### ESLint Rules

- No explicit `any` usage
- Prefer `const` over `let`
- Require array sort compare functions
- Await thenable promises
- No floating promises

### Formatting

- Prettier with consistent configuration
- 2-space indentation
- Single quotes preferred
- Trailing commas for ES5 compatibility
- 100 character line length

## 🤝 Contributing

### Pre-commit Checklist

All commits must pass these automated checks:

- ✅ TypeScript compilation (zero errors)
- ✅ ESLint validation (zero violations)  
- ✅ Prettier formatting (consistent style)
- ✅ Test execution (all tests passing)
- ✅ Coverage thresholds (85%+ minimum)
- ✅ Security audit (no critical issues)

### Development Workflow

1. Create feature branch from main
2. Implement changes following guidelines
3. Add/update tests to maintain coverage
4. Run quality checks locally
5. Submit pull request
6. Automated checks must pass
7. Code review and merge

## 📚 Additional Resources

- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Jest Testing Framework](https://jestjs.io/docs/getting-started)
- [ESLint Rules Reference](https://eslint.org/docs/rules/)
- [Zod Validation Library](https://zod.dev/)
- [IntelliJ IDEA TypeScript Support](https://www.jetbrains.com/help/idea/typescript-support.html)

## 📄 License

MIT License - see LICENSE file for details.

## 🐛 Issues & Support

For issues related to:
- **Project Structure**: Check this README and project guidelines
- **TypeScript Errors**: Verify tsconfig.json and type definitions
- **Test Failures**: Review Jest configuration and test patterns
- **Junie Agent**: Consult `.junie/guidelines.md` for agent behavior

