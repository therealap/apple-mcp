# 🧪 Apple MCP Test Suite

This document explains how to run the comprehensive test suite for Apple MCP tools.

## 🚀 Quick Start

```bash
# Run all tests
npm run test

# Run specific tool tests
npm run test:contacts
npm run test:messages
npm run test:notes
npm run test:mail
npm run test:reminders
npm run test:calendar
npm run test:maps
npm run test:mcp
npm run test:health
```

`test:health` and `test:mcp` need no Mac and no permissions: the first parses
fixture export files in a temp folder, the second validates tool schemas and
drives the server over stdio. Everything else talks to real Apple apps.

## 📋 Prerequisites

### Required Permissions

The tests interact with real Apple apps and require appropriate permissions:

1. **Contacts Access**: Grant permission when prompted
2. **Calendar Access**: Grant permission when prompted
3. **Reminders Access**: Grant permission when prompted
4. **Notes Access**: Grant permission when prompted
5. **Mail Access**: Ensure Mail.app is configured
6. **Messages Access**: May require Full Disk Access for Terminal/iTerm2
   - System Preferences > Security & Privacy > Privacy > Full Disk Access
   - Add Terminal.app or iTerm.app

### Test Phone Number

All messaging and contact tests use: **+1 9999999999**

This number is used consistently across all tests to ensure deterministic results.

## 🧪 Test Structure

```
tests/
├── setup.ts                    # Test configuration & cleanup
├── fixtures/
│   └── test-data.ts            # Test constants with phone number
├── helpers/
│   └── test-utils.ts          # Test utilities & Apple app helpers
├── integration/               # Real Apple app integration tests
│   ├── contacts-simple.test.ts # Basic contacts tests (recommended)
│   ├── contacts.test.ts       # Full contacts tests
│   ├── messages.test.ts       # Messages functionality
│   ├── notes.test.ts          # Notes functionality
│   ├── mail.test.ts           # Mail functionality
│   ├── reminders.test.ts      # Reminders functionality
│   ├── calendar.test.ts       # Calendar functionality
│   ├── maps.test.ts           # Maps functionality
├── unit/                      # Pure tests, no Apple apps required
│   └── health.test.ts         # Health Auto Export parsing
└── mcp/
    └── handlers.test.ts       # MCP tool handler validation
```

## 🔧 Test Types

### 1. Integration Tests

- **Real Apple App Interaction**: Tests actually call AppleScript/JXA
- **Deterministic Data**: Uses consistent test phone number and data
- **Comprehensive Coverage**: Success, failure, and edge cases

### 2. Unit Tests

- **No Apple Apps**: The health tool reads exported JSON files, so its tests
  run anywhere, including CI, with fixtures written to a temp directory
- **No Permissions**: Nothing is prompted for, and nothing is written outside
  that temp directory

### 3. Handler Tests

- **MCP Tool Validation**: Verifies tool schemas and structure, and that the
  DXT manifest advertises the same tools the server does
- **Parameter Validation**: Checks required/optional parameters
- **Error Handling**: Drives a live server over stdio to confirm unknown
  tools and bad arguments come back as error results, and that the server
  stays responsive afterwards

## ⚠️ Troubleshooting

### Common Issues

**Permission Denied Errors:**

- Grant required app permissions in System Preferences
- Restart terminal after granting permissions

**Timeout Errors:**

- Some Apple apps take time to respond
- Tests have generous timeouts but may still timeout on slow systems

**"Command failed" Errors:**

- Usually indicates permission issues
- Check that all required Apple apps are installed and accessible

**JXA/AppleScript Errors:**

- Ensure apps are not busy or in restricted modes
- Close and reopen the relevant Apple app

### Debug Mode

For more detailed output, run individual tests:

```bash
# More verbose contacts testing
npm run test:contacts-full

# Watch mode for development
npm run test:watch
```

## 📊 Test Coverage

The test suite covers:

- ✅ 8 Apple app integrations
- ✅ 100+ individual test cases
- ✅ Real API interactions (no mocking)
- ✅ Error handling and edge cases
- ✅ Performance and timeout handling
- ✅ Concurrent operation testing

## 🎯 Expected Results

**Successful Test Run Should Show:**

- All Apple apps accessible
- Test data created and cleaned up automatically
- Real messages sent/received using test phone number
- Calendar events, notes, reminders created in test folders/lists

**Partial Success is Normal:**

- Some Apple apps may require additional permissions
- Messaging tests require active phone service

## 🧹 Test Data Cleanup

The test suite automatically:

- Creates test folders/lists in Apple apps
- Uses predictable test data names
- Cleans up test data after completion
- Leaves real user data unchanged

Test data uses prefixes like:

- Notes: "Test-Claude" folder
- Reminders: "Test-Claude-Reminders" list
- Calendar: "Test-Claude-Calendar" calendar
- Contacts: "Test Contact Claude" contact
