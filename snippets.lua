local util = require("jit.util")
local function to_console_string(value)
	local kind = type(value)
	local str
	if kind == "string" then
		if string.find(value, "%c") then
			str = string.format("%q", value)
		else
			str = value
		end
	elseif kind == "table" then
		local mt = getmetatable(value)
		local class = rawget(value, "___is_class_metatable___") and "class"
			or (mt and mt ~= true and mt.___is_class_metatable___ and table.find(_G, mt) or "table")
		str = string.format("[%s: %p]", class, value)
	elseif kind == "function" then
		local info = util.funcinfo(value)
		local is_file_func = (info.source and not string.find(info.source, "\n"))
		local where = is_file_func and string.format("%s:%s", info.source, info.linedefined) or (info.addr and string.format("0x%012x", info.addr)) or "<unknown>"
		str = string.format("<%s at %s>", value, where)
	elseif kind == "userdata" then
		str = string.format("{%s: %p}", Script.type_name(value), value)
	else
		str = string.format("%s", value)
	end
	return str
end

rawset(_G, "to_console_string", to_console_string)

local function resolve_path(value, path)
	for i=1, #path do
		local part = path[i]
		if part == -1 then -- Special pseudo-path.
			value = getmetatable(value)
			goto continue
		elseif type(value) == "table" then
			for _, v in pairs(value) do
				if part == 0 then
					value = v
					goto continue
				end
				part = part - 1
			end
		end
		do return nil end
		::continue::
	end
	return value
end

local function format_value(value, name, include_extra_data)
	local kind = type(value)
	local children
	local metatable
	if include_extra_data and kind == "table" then
		children = {}
		for k, v in pairs(value) do
			children[#children+1] = format_value(v, k)
		end

		local mt = getmetatable(value)
		if mt ~= nil then
			metatable = mt and format_value(mt, '__metatable', false)
		end
	end
	return {
		name = to_console_string(name),
		value = to_console_string(value),
		type = kind,
		children = children, metatable = metatable,
	}
end

local env = setmetatable({}, {__index = _G})

local repl_values = {}

local handlers = {
	stack = function(request)
		local response = {}
		for i=1, 9999 do
			local info = debug.getinfo(1+i, "nSl")
			if not info then break end
			response[i] = info
		end
		return response
	end,
	locals = function(request)
		local response = {}
		local level = request.level
		for i=1, 9999 do
			local name, value = debug.getlocal(level, i)
			if not name then break end
			response[i] = format_value(value, name, true)
		end
		return response
	end,
	upvals = function(request)
		local func = debug.getinfo(request.level, "f").func
		local response = {}
		for i=1, 9999 do
			local name, value = debug.getupvalue(func, i)
			if not name then break end
			response[i] = format_value(value, name, true)
		end
		return response
	end,
	contents = function(request)
		local _, value
		local id = request.id
		if id > 0 then
			_, value = debug.getlocal(request.level, id)
		else
			_, value = debug.getupvalue(request.level, -id)
		end
		return format_value(resolve_path(value, request.path), true)
	end,
	repl = function(request)
		table.clear(env)
		local level = request.level
		if level then
			level = level + 2
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- First upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				env[name] = value
			end
			for i=1, 9999 do -- Then locals (in order!).
				local name, value = debug.getlocal(level, i)
				if not name then break end
				env[name] = value
			end
		end
		local thunk, err = loadstring("return "..request.expression, "repl")
		if not thunk then
			thunk = assert(loadstring(request.expression))
		end
		setfenv(thunk, env)
		local result = thunk()
		table.clear(env)
		local id = #repl_values+1
		repl_values[id] = result
		local response = format_value(result, string.format("repl#%d", id), false)
		response.id = id
		return response
	end,
	expandRepl = function(request)
		return format_value(resolve_path(repl_values[request.id], request.path), nil, true)
	end,
	disassemble = function(request)

	end,
}

function VSCodeDebugAdapter(str)
	local request = cjson.decode(str)
	local ok, result = pcall(handlers[request.request_type], request)
	Application.console_send({
		type = "vscode_debug_adapter",
		request_id = request.request_id,
		request_type = request.request_type,
		result = result,
		ok = ok,
	})
end