import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsOptional()
  @IsEnum(Environment)
  NODE_ENV?: Environment;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @IsUrl({ require_tld: false })
  OLLAMA_BASE_URL?: string;

  @IsOptional()
  @IsString()
  OLLAMA_MODEL?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  SCAN_MCP_URL?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  AGENT_MAX_STEPS?: number;

  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;
}

export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig);

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  return validatedConfig;
}
