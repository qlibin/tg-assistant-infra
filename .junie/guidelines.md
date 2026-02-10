# Project Guidelines for Junie Agent

## TypeScript Standards
- Always use strict mode and strong typing
- Never use 'any' type - use 'unknown' or proper types
- Follow established project patterns and conventions
- Use proper error handling with typed exceptions

## Testing Requirements
- Generate comprehensive tests for all new functionality
- Maintain 85% minimum test coverage
- Follow AAA pattern in tests
- Mock external dependencies properly
- Do not ever remove snapshot test, instead update the snapshot when it fails with `npm test -- -u` command.
- For cdk and aws cli commands use profile "aws-course"

## Code Quality
- Run ESLint and fix all issues before completion
- Format code with Prettier
- Ensure TypeScript compilation passes
- Follow project's naming conventions

## Security
- Validate all inputs with proper type checking
- Never hardcode sensitive data
- Use secure coding practices for data handling
- Implement proper error handling without information leakage

## Project Structure
- CDK application located in infrastructure/
- Use a typical CDK application structure

## Naming Conventions
- Variables & Functions: camelCase
- Classes & Interfaces: PascalCase
- Constants: SCREAMING_SNAKE_CASE
- Files: kebab-case.ts

## Import Organization
1. External libraries first
2. Internal modules (absolute paths)
3. Relative imports last
