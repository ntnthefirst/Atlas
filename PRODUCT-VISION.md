# Product Vision: An Adaptive Local Productivity Platform

This document describes the goal of the app: what we are building, why, and how the
pieces fit together. It is a concept and direction document, not an implementation spec.

## Summary

We want to create a lightweight intelligent productivity platform that acts as a personal
operating layer on top of the user's computer. The application does not replace existing
applications, but connects them together and makes the computer more adaptive, faster, and
easier to control.

The main idea is to create a system that reduces small repetitive actions, understands user
behavior, and provides intelligent assistance without becoming heavy, intrusive, or
dependent on the cloud.

The product consists of three main parts:

1. The Notch
2. The Main Application
3. The Intelligent Environment System

## The Notch

The Notch is the primary interface of the product.

It is a small, always available interface that allows the user to interact with their
computer instantly. The Notch should feel like a natural extension of the operating system
rather than another application.

The user should be able to complete most daily actions directly from the Notch:

- Search files
- Open applications
- Launch websites
- Ask AI questions
- Execute commands
- Start timers
- Manage tasks
- View reminders
- Trigger automations
- Switch environments
- Access integrations
- Control system settings
- View smart suggestions

### Context adaptation

The Notch adapts depending on the current context.

When coding:

- Show active projects
- Running servers
- Git information
- Development shortcuts

When studying:

- Show notes
- Tasks
- Research tools

When working:

- Show calendar
- Communication tools
- Important tasks

The user does not need to manually configure everything. The system learns which actions
are useful and gradually improves.

## The Main Application

The full desktop application is the management and customization center. Users do not
constantly work inside this application; it exists for deeper control.

The application allows users to:

- Manage environments
- Configure the Notch
- View statistics
- Manage findings
- Create smart functions
- Manage integrations
- Configure AI settings
- Control privacy
- Manage automation
- View system activity
- Manage plugins
- Configure appearance

The Notch is the daily workspace. The application is where the user builds their personal
system.

## User-Created Environments

Environments are personal digital contexts created by the user. The user chooses the name,
purpose, and behavior. For example:

- Work
- Personal
- School
- Client Project
- Game Development
- Content Creation
- Streaming
- Research
- Freelance

The application does not decide what environments exist. The user creates them.

Each environment can have:

- Custom Notch layout
- Custom shortcuts
- Custom integrations
- Custom AI behavior
- Custom findings
- Custom smart functions
- Custom themes
- Custom permissions
- Custom tools

An environment represents a way of working.

### Environment Intelligence

Environments are not necessarily completely isolated. The user decides how separated they
should be.

**Connected Mode**

The environment has its own context but can learn from general user behavior.

Example: the user creates a "Programming" environment. The system already knows from
general behavior that "when this user starts a local server, they usually open the
browser." The environment can use this knowledge. However, it does not automatically share
sensitive data.

**Enclosed Mode**

The environment becomes completely separated. Useful for:

- Company work
- Client projects
- Private research
- Sensitive information

The following stays isolated:

- AI memory
- Findings
- Indexed data
- Connected accounts
- Documents
- Activity history

## Findings System

Findings are automatically discovered patterns in user behavior. The system observes
actions and looks for repeated workflows.

Example — a developer:

1. Opens VS Code
2. Starts a server
3. Opens localhost
4. Opens documentation

The system creates a finding: "You usually open localhost after starting this server."
Suggestion: "Open localhost automatically?"

Another example — the user always opens Figma, Slack, a browser, and the project folder at
the start of a project. The system suggests: "Create a workspace setup?"

Findings are not immediate automations. The system first learns:

1. Detect behavior pattern.
2. Create temporary finding.
3. Show suggestion.
4. User accepts or ignores.
5. If accepted, create a smart function.
6. Remove temporary learning data.
7. Continue searching for new patterns.

This prevents endless data collection and keeps the system efficient.

### Finding Management

Users can see all discovered patterns. They can:

- Accept findings
- Reject findings
- Delete findings
- Pause findings
- Convert findings into actions
- Move findings between environments
- Edit finding behavior

The user always remains in control.

## Smart Functions

Smart Functions are user-created rules. They are similar to personal assistants:

- "When I open this project, show these tools."
- "When I connect my work monitor, switch to this environment."
- "When I start coding, start a timer."
- "When I finish a meeting, create notes."

These can be created manually or generated by AI.

## Automation and Macro System

The application includes a macro recorder. The user can record actions:

- Mouse movement
- Mouse clicks
- Keyboard input
- Window interactions
- Application actions

The recorded sequence can be replayed later, for example:

- Filling repetitive forms
- Opening a standard setup
- Repeating design actions
- Automating repetitive computer tasks

Macros are separate from AI findings. A macro is a direct recorded action sequence; a
finding is a discovered behavior pattern. They can work together, but they are different
systems.

## AI System

AI is an intelligence layer, not the main product. The system prioritizes local processing.

Possible capabilities:

- Local LLM support
- Cloud AI connection
- Context understanding
- File analysis
- Search assistance
- Text improvement
- Summaries
- Code explanation
- Workflow suggestions
- Environment customization

The user can ask:

- "Create a finding when I start my server."
- "Show all patterns from this environment."
- "Change my Notch layout."
- "Create a new environment for this project."

### MCP and External AI Tools

The application can support MCP-compatible servers and external AI tools. This allows AI
systems to interact with the user's environment through controlled permissions.

AI can access, for example:

- GitHub
- Figma
- Notion
- Calendar
- Files
- Development tools
- Local applications

The user controls which tools are available. The application becomes a bridge between AI
systems and the user's computer.

## Integrations

The platform connects with existing applications instead of replacing them.

**Development**

- GitHub
- GitLab
- VS Code
- JetBrains IDEs
- Docker
- Terminal

**Design**

- Figma
- Adobe applications
- Blender

**Productivity**

- Notion
- Obsidian
- Google Calendar
- Outlook
- Todoist

**Communication**

- Slack
- Discord
- Microsoft Teams

**Storage**

- Google Drive
- OneDrive
- Dropbox

**Media**

- Spotify
- YouTube Music

Integrations allow the Notch and AI system to understand the user's workflow.

## Statistics and Insights

The application provides insights about usage:

- Time spent per environment
- Time spent per application
- Most common workflows
- Completed tasks
- Macro usage
- Finding improvements
- Productivity trends

The goal is not surveillance. The goal is helping users understand and improve their
workflow.

## Privacy and Local First Architecture

The application is designed around local processing. Important principles:

- Local indexing
- Local AI support
- Encrypted storage
- User-controlled permissions
- Optional cloud services
- Environment separation

The user owns their data.

## Overall Vision

This application is a personal adaptive layer between the user and their computer.

It combines:

- A universal Notch interface
- User-created environments
- Local intelligence
- AI assistance
- Pattern recognition
- Smart suggestions
- Macro automation
- Application integrations
- MCP connectivity
- Personal workflows

The computer should not only execute commands. It should understand the way each individual
works and gradually remove unnecessary friction.

The goal is not to create another productivity application. The goal is to create a
smarter, lighter, more personal way to use a computer.
