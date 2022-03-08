local function ctlsub(c)
	if c == "\n" then return "\\n"
	elseif c == "\r" then return "\\r"
	elseif c == "\t" then return "\\t"
	--elseif c == "\\" then return "\\\\"
	--elseif c == "\"" then return "\\\""
	else return string.format("\\%03d", string.byte(c))
	end
end

local util = require("jit.util")
local function to_console_string(value)
	local kind = type(value)
	local str
	if kind == "string" then
		if string.find(value, "%c") then
			str = string.gsub(string.format("%q", value), "%c", ctlsub)
		else
			str = value
		end
	elseif kind == "table" then
		local mt = getmetatable(value)
		local class = rawget(value, "___is_class_metatable___") and "class"
			or (mt and mt ~= true and mt.___is_class_metatable___ and table.find(_G, mt) or "table")
		str = string.format("%s {…}: %p ", class, value)
	elseif kind == "function" then
		str = string.format("ƒ (): %p", value)
	elseif kind == "userdata" then
		if string.format("%p", value) == "0x00004004" then
			str = "sentinel"
		else
			str = tostring(value)
		end
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
		end
		local kind = type(value)
		if kind == "function" then
			value = util.funcinfo(value)
		elseif kind ~= "table" then
			return nil
		end
		for _, v in pairs(value) do
			if part == 0 then
				value = v
				goto continue
			end
			part = part - 1
		end
		::continue::
	end
	return value
end

local ffi = require("ffi")
local function table_size(t)
	local addr = string.match(string.format("%p", t), "0x(%x+)")
	assert(addr, "invalid pointer")
	local ptr = ffi.cast("uint32_t*", tonumber(addr, 16))
	return ptr[6], ptr[7]
end

local function format_value(value, name, include_children, is_nested)
	local kind = type(value)
	local children
	local metatable
	if include_children then
		if kind == "table" or kind == "function" then
			children = {}
			local iterationValue = value
			if kind == "function" then
				iterationValue = util.funcinfo(value)
				if iterationValue.addr then
					iterationValue.addr = string.format("%016x", iterationValue.addr)
				end
			end
			for k, v in pairs(iterationValue) do
				children[#children+1] = format_value(v, k)
			end
			if kind == "table" then
				local mt = getmetatable(value)
				if mt ~= nil then
					children[#children+1] = format_value(mt, '(metatable)')
				end
				local asize, hsize = table_size(value)
				children[#children+1] = format_value(asize, '(size array)')
				children[#children+1] = format_value(hsize, '(size hash)')
			end
		end
	end
	local value_str
	if not is_nested and kind == "string" then
		value_str = string.gsub(string.format("%q", value), "\\9%f[%D]", "\t")
	end
	return {
		name = to_console_string(name),
		value = value_str or to_console_string(value),
		type = kind,
		children = children, metatable = metatable,
	}
end

local function make_environment(level)
	level = level + 1
	return setmetatable({}, {
		__index = function(_, target_name)
			local found, target_value = false
			for i=1, 9999 do -- (1) Locals.
				local name, value = debug.getlocal(level, i)
				if not name then break end
				-- Need to keep the last match in case there is name shadowing.
				if name == target_name then
					found = true
					target_value = value
				end
			end
			if found then
				return target_value
			end
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- (2) Upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				if name == target_name then
					return value
				end
			end
			return rawget(_G, target_name) -- (3) Globals.
		end,
		__newindex = function(_, target_name, target_value)
			local found, target_i = false
			for i=1, 9999 do -- (1) Locals.
				local name = debug.getlocal(level, i)
				if not name then break end
				-- Need to keep the last match in case there is name shadowing.
				if name == target_name then
					found = true
					target_i = i
				end
			end
			if found then
				debug.setlocal(level, target_i, target_value)
			end
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- (2) Upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				if name == target_name then
					debug.setupvalue(func, i, target_value)
					return
				end
			end
			rawset(_G, target_name, target_value) -- (3) Globals.
		end,
	})
end

local EVAL_REGISTRY = {}

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
		for i=1, 1000000000 do
			local name, value = debug.getlocal(level, i)
			if not name then break end
			response[i] = format_value(value, name)
		end
		return response
	end,
	upvals = function(request)
		local func = debug.getinfo(request.level, "f").func
		local response = {}
		for i=1, 1000000000 do
			local name, value = debug.getupvalue(func, i)
			if not name then break end
			response[i] = format_value(value, name)
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
		return format_value(resolve_path(value, request.path))
	end,
	eval = function(request)
		-- If a stack level is provided, we have to adjust it skipping all the
		-- debug stuff that is currently on the stack. This is *very* brittle.
		local id = #EVAL_REGISTRY+1
		local eval_name = string.format("eval#%d", id)
		local thunk = loadstring("return ("..request.expression..")", eval_name)
		if not thunk then
			thunk = assert(loadstring(request.expression, eval_name))
		end
		local environment = request.level and make_environment(request.level + (3+2)) or _G
		setfenv(thunk, environment)
		local result = thunk()
		local completion = request.completion
		local response = format_value(result, eval_name, completion)
		if not completion then
			EVAL_REGISTRY[id] = result
			response.id = id
		end
		return response
	end,
	expandEval = function(request)
		return format_value(resolve_path(EVAL_REGISTRY[request.id], request.path), nil, true, true)
	end,
}

local cjson = stingray.cjson.stingray_init()

local function VSCodeDebugAdapter(str)
	local request = cjson.decode(str)
	local ok, result = pcall(handlers[request.request_type], request)
	stingray.Application.console_send({
		type = "vscode_debug_adapter",
		request_id = request.request_id,
		request_type = request.request_type,
		result = result,
		ok = ok,
	})
end

rawset(_G, "VSCodeDebugAdapter", VSCodeDebugAdapter)

stingray.Application.console_send({
	type = "vscode_debug_adapter",
	request_id = "inject",
	request_type = "inject",
	result = true,
	ok = true,
})
